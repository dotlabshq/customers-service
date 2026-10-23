import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireOrg } from '@baseworks/org/hono'
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
 * customers-service routes, at the service ROOT.
 *
 * A gateway publishes the realm at `/v1/customers/...` and strips that prefix
 * (ADR-042 §4), so the service never encodes where it happens to be mounted.
 * app.ts also mounts these under `/v1` for callers that predate the gateway.
 *
 * Every request is:
 *   1. authenticated (identity JWT → userId), then
 *   2. bound to an org via `X-Org-Id`, whose membership is verified against
 *      org-service (the PDP) by forwarding the caller's token — so a user can
 *      only touch orgs they belong to. The org id is the foldbase tenant.
 */
export function customersRouter(store: Store, orgBaseUrl: string) {
  const app = new Hono()
  app.use('*', requireAuth)

  // Which org this request is for: `X-Org-Id` resolved through the PDP to
  // the canonical id, membership checked, a narrowed token held to its org.
  // The same middleware every service in the realm uses (@baseworks/org/hono);
  // what it stores as `orgId` is the storage tenant.
  app.use('*', requireOrg({ baseUrl: orgBaseUrl }))

  const orgOf = (c: { get: (k: string) => unknown }) => c.get('orgId') as string
  const actorOf = (c: { get: (k: string) => unknown }) => (c.get('auth') as { userId: string }).userId

  app.get('/customers', async (c) => {
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

  app.get('/customers/:ref', async (c) => {
    const customer = await store.getCustomer(orgOf(c), c.req.param('ref'))
    if (!customer) return c.json({ error: 'not_found', message: 'Customer not found' }, 404)
    return c.json({ customer })
  })

  app.post('/customers', zValidator('json', CreateSchema), async (c) => {
    const customer = await store.createCustomer(orgOf(c), c.req.valid('json'), actorOf(c)).catch(fail)
    return c.json({ customer }, 201)
  })

  app.patch('/customers/:ref', zValidator('json', UpdateSchema), async (c) => {
    const customer = await store.updateCustomer(orgOf(c), c.req.param('ref'), c.req.valid('json'), actorOf(c)).catch(fail)
    return c.json({ customer })
  })

  app.delete('/customers/:ref', async (c) => {
    await store.archiveCustomer(orgOf(c), c.req.param('ref'), actorOf(c)).catch(fail)
    return c.body(null, 204)
  })

  return app
}
