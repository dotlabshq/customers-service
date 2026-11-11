import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { CUSTOMER_KINDS, CUSTOMER_ROLES, LOCKABLE_FIELDS } from '@baseworks/customers/events'
import { requireOrg } from '@baseworks/org/hono'
import { requireAuth } from '../lib/auth.js'
import { permit, type OrgAccess } from '../lib/org.js'
import { StoreError, type Store } from '../store.js'

const AddressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
})

const Kind = z.enum(CUSTOMER_KINDS)
const Roles = z.array(z.enum(CUSTOMER_ROLES)).min(1)
const Fields = z.array(z.enum(LOCKABLE_FIELDS))
// Not `.url()`: people type `acme.com`, and that is what is kept.
const Website = z.string().max(300)

const CreateSchema = z.object({
  name: z.string().min(1),
  kind: Kind.optional(),
  roles: Roles.optional(),
  website: Website.optional(),
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
  kind: Kind.optional(),
  roles: Roles.optional(),
  website: Website.optional(),
  lock: Fields.optional(),
  unlock: Fields.optional(),
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
 * customers-service routes. They are the API: app.ts mounts them under `/api`,
 * and a gateway publishes that at `/v1/customers` by replacing the prefix
 * (workspace ADR 0003), so the service never encodes where it is published.
 *
 * Every request is:
 *   1. authenticated (identity JWT → userId), then
 *   2. bound to an org via `X-Org-Id`, whose membership is verified against
 *      org-service by forwarding the caller's token. The org id is the
 *      foldbase tenant. Then
 *   3. allowed or refused by permission: org-service says which of this
 *      service's actions the person may do there, and the route names the one
 *      it needs. No role is named here.
 */
export function customersRouter(store: Store, orgBaseUrl: string, org: OrgAccess) {
  const app = new Hono()
  app.use('*', requireAuth)

  // Which org this request is for: `X-Org-Id` resolved through the PDP to
  // the canonical id, membership checked, a narrowed token held to its org.
  // The same middleware every service in the realm uses (@baseworks/org/hono);
  // what it stores as `orgId` is the storage tenant.
  app.use('*', requireOrg({ baseUrl: orgBaseUrl }))

  const orgOf = (c: { get: (k: string) => unknown }) => c.get('orgId') as string
  const actorOf = (c: { get: (k: string) => unknown }) => (c.get('auth') as { userId: string }).userId

  app.get('/customers', permit(org, 'customer.read'), async (c) => {
    const orgId = orgOf(c)
    const externalId = c.req.query('external_id')
    if (externalId) {
      const customer = await store.getByExternalId(orgId, externalId)
      if (!customer) return c.json({ error: 'not_found', message: 'Customer not found' }, 404)
      return c.json({ customer })
    }
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500)
    const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0
    const kind = Kind.safeParse(c.req.query('kind'))
    const role = z.enum(CUSTOMER_ROLES).safeParse(c.req.query('role'))
    if (c.req.query('kind') && !kind.success) return c.json({ error: 'invalid_kind', message: `kind is one of ${CUSTOMER_KINDS.join(', ')}` }, 400)
    if (c.req.query('role') && !role.success) return c.json({ error: 'invalid_role', message: `role is one of ${CUSTOMER_ROLES.join(', ')}` }, 400)
    const taxId = c.req.query('tax_id')
    return c.json({
      customers: await store.listCustomers(orgId, {
        limit, offset,
        ...(kind.success ? { kind: kind.data } : {}),
        ...(role.success ? { role: role.data } : {}),
        ...(taxId ? { taxId } : {}),
      }),
    })
  })

  app.get('/customers/:ref', permit(org, 'customer.read'), async (c) => {
    const customer = await store.getCustomer(orgOf(c), c.req.param('ref'))
    if (!customer) return c.json({ error: 'not_found', message: 'Customer not found' }, 404)
    return c.json({ customer })
  })

  app.post('/customers', permit(org, 'customer.write'), zValidator('json', CreateSchema), async (c) => {
    const customer = await store.createCustomer(orgOf(c), c.req.valid('json'), actorOf(c)).catch(fail)
    return c.json({ customer }, 201)
  })

  app.patch('/customers/:ref', permit(org, 'customer.write'), zValidator('json', UpdateSchema), async (c) => {
    const patch = c.req.valid('json')
    // A lock is a person saying "leave this as I set it". A service cannot say
    // that, and cannot take it back.
    if ((patch.lock?.length || patch.unlock?.length) && c.get('orgRole') === 'service') {
      return c.json({ error: 'person_only', message: 'Only a person locks or unlocks a field' }, 403)
    }
    const { customer, skippedFields } = await store.updateCustomer(orgOf(c), c.req.param('ref'), patch, actorOf(c)).catch(fail)
    return c.json({ customer, skippedFields })
  })

  app.delete('/customers/:ref', permit(org, 'customer.archive'), async (c) => {
    await store.archiveCustomer(orgOf(c), c.req.param('ref'), actorOf(c)).catch(fail)
    return c.body(null, 204)
  })

  // Bring an archived record back. By id: an archived record has no other handle.
  app.post('/customers/:id/restore', permit(org, 'customer.archive'), async (c) => {
    const customer = await store.restoreCustomer(orgOf(c), c.req.param('id'), actorOf(c)).catch(fail)
    return c.json({ customer })
  })

  // ── links: which person is at which company ───────────────────────────────

  app.get('/customers/:ref/links', permit(org, 'customer.read'), async (c) =>
    c.json({ links: await store.listLinks(orgOf(c), c.req.param('ref')).catch(fail) }))

  app.post(
    '/customers/:ref/links',
    permit(org, 'customer.write'),
    zValidator('json', z.object({ to: z.string().min(1), title: z.string().max(120).optional() })),
    async (c) => {
      const link = await store.addLink(orgOf(c), c.req.param('ref'), c.req.valid('json'), actorOf(c)).catch(fail)
      return c.json({ link }, 201)
    },
  )

  app.patch(
    '/customers/:ref/links/:linkId',
    permit(org, 'customer.write'),
    zValidator('json', z.object({ title: z.string().max(120) })),
    async (c) => {
      const link = await store
        .retitleLink(orgOf(c), c.req.param('ref'), c.req.param('linkId'), c.req.valid('json').title, actorOf(c))
        .catch(fail)
      return c.json({ link })
    },
  )

  app.delete('/customers/:ref/links/:linkId', permit(org, 'customer.write'), async (c) => {
    await store.removeLink(orgOf(c), c.req.param('ref'), c.req.param('linkId'), actorOf(c)).catch(fail)
    return c.body(null, 204)
  })

  return app
}
