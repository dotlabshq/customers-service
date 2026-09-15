import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  bootTestFoldBase, fakeOrgService, makeServiceToken, makeTestApp, makeToken,
  newOrgId, type TestFoldBase,
} from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
type Customer = {
  id: string; shortId: string; name: string
  email: string | null; externalId: string | null; currency: string | null
}

let fb: TestFoldBase
let app: App
let orgId: string
let restoreOrg: () => void

const json = <T>(res: Response) => res.json() as Promise<T>
const create = (body: Record<string, unknown>, o?: { token?: string; org?: string | null }) =>
  app.post('/customers', body, o)

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => {
  orgId = newOrgId()
  app = await makeTestApp(fb, orgId)
  restoreOrg = fakeOrgService({ [orgId]: 'owner' })
})
afterEach(() => restoreOrg())

// ── the two gates every request passes ───────────────────────────────────────

describe('a request needs an identity and an org', () => {
  it('no token is 401', async () => {
    expect((await app.unauth('/customers')).status).toBe(401)
  })

  it('no X-Org-Id is 400, and says what to do about it', async () => {
    const res = await app.get('/customers', { org: null })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toBe('org_required')
  })

  it('an org the caller is not a member of is 403', async () => {
    const res = await app.get('/customers', { org: 'org-somebody-elses' })
    expect(res.status).toBe(403)
  })

  it('a service token skips the membership check — it acts for the plane, not a person', async () => {
    const res = await app.get('/customers', { token: makeServiceToken('pay-service'), org: 'org-anything' })
    expect(res.status).toBe(200)
  })
})

// ── the directory ────────────────────────────────────────────────────────────

describe('customers', () => {
  it('creates one and reads it back by id and by short id', async () => {
    const res = await create({ name: 'Acme GmbH', email: 'billing@acme.test', currency: 'EUR' })
    expect(res.status).toBe(201)
    const { customer } = await json<{ customer: Customer }>(res)
    expect(customer).toMatchObject({ name: 'Acme GmbH', email: 'billing@acme.test', currency: 'EUR' })

    for (const ref of [customer.id, customer.shortId]) {
      const got = await json<{ customer: Customer }>(await app.get(`/customers/${ref}`))
      expect(got.customer.id).toBe(customer.id)
    }
  })

  it('lists what this org has, and nothing another org has', async () => {
    await create({ name: 'Ours' })
    // A second org the caller is also a member of, with its own directory.
    const other = newOrgId()
    restoreOrg()
    restoreOrg = fakeOrgService({ [orgId]: 'owner', [other]: 'owner' })
    await create({ name: 'Theirs' }, { org: other })

    const ours = await json<{ customers: Customer[] }>(await app.get('/customers'))
    expect(ours.customers.map((c) => c.name)).toEqual(['Ours'])

    const theirs = await json<{ customers: Customer[] }>(await app.get('/customers', { org: other }))
    expect(theirs.customers.map((c) => c.name)).toEqual(['Theirs'])
  })

  it('resolves a customer by the id it has in the caller\'s own system', async () => {
    await create({ name: 'Acme', externalId: 'CUST-99' })
    const found = await json<{ customer: Customer }>(await app.get('/customers?external_id=CUST-99'))
    expect(found.customer.name).toBe('Acme')

    expect((await app.get('/customers?external_id=CUST-NOPE')).status).toBe(404)
  })

  it('refuses a second customer with the same external id', async () => {
    await create({ name: 'First', externalId: 'CUST-1' })
    expect((await create({ name: 'Second', externalId: 'CUST-1' })).status).toBe(409)
  })

  it('changes only the fields it is given', async () => {
    const { customer } = await json<{ customer: Customer }>(
      await create({ name: 'Before', email: 'keep@acme.test', currency: 'EUR' }),
    )
    const res = await app.patch(`/customers/${customer.shortId}`, { name: 'After' })
    expect(res.status).toBe(200)

    const after = (await json<{ customer: Customer }>(res)).customer
    expect(after.name).toBe('After')
    expect(after.email).toBe('keep@acme.test')
    expect(after.currency).toBe('EUR')
  })

  it('refuses an empty patch rather than writing an event that says nothing', async () => {
    const { customer } = await json<{ customer: Customer }>(await create({ name: 'Acme' }))
    expect((await app.patch(`/customers/${customer.id}`, {})).status).toBe(400)
  })

  it('archiving takes a customer out of the directory', async () => {
    const { customer } = await json<{ customer: Customer }>(await create({ name: 'Gone' }))
    expect((await app.del(`/customers/${customer.id}`)).status).toBe(204)

    expect((await app.get(`/customers/${customer.id}`)).status).toBe(404)
    const list = await json<{ customers: Customer[] }>(await app.get('/customers'))
    expect(list.customers).toHaveLength(0)
  })

  it('a customer of another org is not found, not forbidden', async () => {
    const other = newOrgId()
    restoreOrg()
    restoreOrg = fakeOrgService({ [orgId]: 'owner', [other]: 'owner' })
    const { customer } = await json<{ customer: Customer }>(await create({ name: 'Theirs' }, { org: other }))

    // 404 rather than 403: the caller is a member of the org they named, and
    // being told "forbidden" would confirm the id exists somewhere else.
    expect((await app.get(`/customers/${customer.id}`)).status).toBe(404)
  })
})

// ── where the routes live ────────────────────────────────────────────────────

describe('mount paths', () => {
  it('serves the same resource at the root and under the legacy /v1 prefix', async () => {
    await create({ name: 'Acme' })
    const root = await app.get('/customers')
    const legacy = await app.get('/v1/customers')
    expect(root.status).toBe(200)
    expect(await root.json()).toEqual(await legacy.json())
  })

  it('answers the manifest without a token', async () => {
    const res = await app.app.fetch(new Request('http://localhost/.well-known/service'))
    expect(res.status).toBe(200)
    expect(await json<{ name: string; api_version: string }>(res)).toMatchObject({
      name: 'customers', api_version: '1.0',
    })
  })
})

// ── one organization, one directory ──────────────────────────────────────────
//
// X-Org-Id may name an org by id, slug or short id, and the org id is the
// storage tenant. Using the header verbatim would give `acme` and the org's
// real id a separate directory each — one organization, two sets of customers,
// depending on which client wrote them.

describe('the org is resolved before it is stored against', () => {
  it('a customer added under a slug is found under the id, and the other way round', async () => {
    restoreOrg()
    restoreOrg = fakeOrgService({ [orgId]: 'owner' }, { acme: orgId })

    await create({ name: 'Added by the CLI' }, { org: 'acme' })
    const byId = await json<{ customers: Customer[] }>(await app.get('/customers', { org: orgId }))
    expect(byId.customers.map((c) => c.name)).toEqual(['Added by the CLI'])

    await create({ name: 'Added by the console' }, { org: orgId })
    const bySlug = await json<{ customers: Customer[] }>(await app.get('/customers', { org: 'acme' }))
    expect(bySlug.customers.map((c) => c.name).sort()).toEqual(['Added by the CLI', 'Added by the console'])
  })
})
