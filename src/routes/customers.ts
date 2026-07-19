import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { createOrgClient, OrgError } from '@baseworks/org'
import { requireAuth } from '../lib/auth.js'
import { StoreError, type Store } from '../store.js'

const AddressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
})

const CreateSchema = z.object({
  name: z.string().min(1),
  externalId: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  taxId: z.string().optional(),
  currency: z.string().length(3).optional(),
  address: AddressSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  taxId: z.string().optional(),
  currency: z.string().length(3).optional(),
  address: AddressSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field' })

function fail(err: unknown): never {
  if (err instanceof StoreError) throw err
  throw new StoreError(500, 'internal', (err as Error).message)
}

/**
 * customers-service routes. Every request is:
 *   1. authenticated (identity JWT → userId), then
 *   2. bound to an org via `X-Org-Id`, whose membership is verified against
 *      org-service (the PDP) by forwarding the caller's token — so a user can
 *      only touch orgs they belong to. The org id is the foldbase tenant.
 */
export function customersRouter(store: Store, orgBaseUrl: string) {
  const app = new Hono()
  app.use('*', requireAuth)

  // Resolve + authorize the org for this request.
  app.use('*', async (c, next) => {
    const orgId = c.req.header('X-Org-Id')
    if (!orgId) {
      return c.json({ error: 'org_required', message: 'Missing X-Org-Id — run `use <org>` first' }, 400)
    }
    const bearer = c.req.header('Authorization')!.slice(7)
    // Service tokens (plane-signed, e.g. stripe-service reconciling a webhook via
    // pay-service → customer resolution) skip the per-user membership check.
    if ((c.get('auth') as { tokenType?: string } | undefined)?.tokenType === 'service') {
      c.set('orgId' as never, orgId as never); c.set('bearer' as never, bearer as never)
      return next()
    }
    const org = createOrgClient({ baseUrl: orgBaseUrl, token: bearer })
    try {
      const { role } = await org.effectiveRole(orgId)
      if (role === 'none') return c.json({ error: 'forbidden', message: 'Not a member of this org' }, 403)
      c.set('orgId' as never, orgId as never)
    } catch (e) {
      if (e instanceof OrgError && e.status === 404) {
        return c.json({ error: 'org_not_found', message: 'Active org does not exist — run `use <org>` with a valid org' }, 404)
      }
      return c.json({ error: 'authz_unavailable', message: (e as Error).message }, 502)
    }
    return next()
  })

  const orgOf = (c: { get: (k: string) => unknown }) => c.get('orgId') as string
  const actorOf = (c: { get: (k: string) => unknown }) => (c.get('auth') as { userId: string }).userId

  app.get('/v1/customers', async (c) => {
    const orgId = orgOf(c)
    const externalId = c.req.query('external_id')
    if (externalId) {
      const customer = await store.getByExternalId(orgId, externalId)
      if (!customer) return c.json({ error: 'not_found', message: 'Customer not found' }, 404)
      return c.json({ customer })
    }
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500)
    const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0
    return c.json({ customers: await store.listCustomers(orgId, { limit, offset }) })
  })

  app.get('/v1/customers/:ref', async (c) => {
    const customer = await store.getCustomer(orgOf(c), c.req.param('ref'))
    if (!customer) return c.json({ error: 'not_found', message: 'Customer not found' }, 404)
    return c.json({ customer })
  })

  app.post('/v1/customers', zValidator('json', CreateSchema), async (c) => {
    const customer = await store.createCustomer(orgOf(c), c.req.valid('json'), actorOf(c)).catch(fail)
    return c.json({ customer }, 201)
  })

  app.patch('/v1/customers/:ref', zValidator('json', UpdateSchema), async (c) => {
    const customer = await store.updateCustomer(orgOf(c), c.req.param('ref'), c.req.valid('json'), actorOf(c)).catch(fail)
    return c.json({ customer })
  })

  app.delete('/v1/customers/:ref', async (c) => {
    await store.archiveCustomer(orgOf(c), c.req.param('ref'), actorOf(c)).catch(fail)
    return c.body(null, 204)
  })

  return app
}
