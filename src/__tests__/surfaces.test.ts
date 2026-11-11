/**
 * The mounts (workspace ADR 0003) and the permission gate: the API under
 * `/api`, `/healthz` at the root only, the two older mounts kept for now, and
 * every route asking org-service for a permission, never for a role.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bootTestFoldBase, fakeOrgService, makeServiceToken, makeTestApp, newOrgId, type FakeOrgOptions, type TestFoldBase,
} from './setup.js'
import { CUSTOMERS_ACTIONS, orgAccess, registerWithOrg } from '../lib/org.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
let fb: TestFoldBase
let app: App
let orgId: string
let restore: ReturnType<typeof fakeOrgService> | undefined

const json = async <T>(res: Response) => (await res.json()) as T
const as = (role: string, o: FakeOrgOptions = {}) => { restore?.(); restore = fakeOrgService({ [orgId]: role }, o) }

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => { orgId = newOrgId(); app = await makeTestApp(fb, orgId); as('owner') })
afterEach(() => { restore?.(); restore = undefined })

describe('the API is under /api', () => {
  it('answers there, discovery and the contract included', async () => {
    expect((await app.post('/api/customers', { name: 'Acme' })).status).toBe(201)
    expect((await json<{ customers: unknown[] }>(await app.get('/api/customers'))).customers).toHaveLength(1)
    expect((await json<{ name: string }>(await app.unauth('/api/.well-known/service'))).name).toBe('customers')
    expect((await app.unauth('/api/openapi.yaml')).status).toBe(200)
  })

  it('/healthz is at the root only, so no published prefix reaches it', async () => {
    expect((await app.unauth('/healthz')).status).toBe(200)
    expect((await app.unauth('/api/healthz')).status).toBe(401)
  })

  it('the older mounts still answer, with the same gates', async () => {
    expect((await app.get('/customers')).status).toBe(200)
    expect((await app.get('/v1/customers')).status).toBe(200)
    as('viewer')
    expect((await app.post('/v1/customers', { name: 'Acme' })).status).toBe(403)
  })
})

describe('a route asks for a permission', () => {
  it('a viewer reads and cannot write or archive', async () => {
    const made = await json<{ customer: { id: string } }>(await app.post('/api/customers', { name: 'Acme' }))
    as('viewer')
    expect((await app.get('/api/customers')).status).toBe(200)
    expect((await app.get(`/api/customers/${made.customer.id}`)).status).toBe(200)
    const refused = await app.post('/api/customers', { name: 'Beta' })
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ error: 'forbidden', permission: 'customer.write' })
    expect((await app.patch(`/api/customers/${made.customer.id}`, { name: 'Acme 2' })).status).toBe(403)
    expect(await json(await app.del(`/api/customers/${made.customer.id}`))).toMatchObject({ permission: 'customer.archive' })
  })

  it('a member writes and archives', async () => {
    as('member')
    const made = await json<{ customer: { id: string } }>(await app.post('/api/customers', { name: 'Acme' }))
    expect((await app.patch(`/api/customers/${made.customer.id}`, { name: 'Acme 2' })).status).toBe(200)
    expect((await app.del(`/api/customers/${made.customer.id}`)).status).toBe(204)
  })

  it('with no manifest registered, a member of the org is refused everything', async () => {
    as('owner', { registered: false })
    expect((await app.get('/api/customers')).status).toBe(403)
    expect((await app.post('/api/customers', { name: 'Acme' })).status).toBe(403)
  })

  it('when org-service cannot be asked, the answer is 502 and not yes', async () => {
    as('owner', { permissionsDown: true })
    const res = await app.get('/api/customers')
    expect(res.status).toBe(502)
    expect((await json<{ error: string }>(res)).error).toBe('authz_unavailable')
  })

  it('a service token acts as itself and is not asked about', async () => {
    as('none')
    const res = await app.get('/api/customers', { token: makeServiceToken('billing') })
    expect(res.status).toBe(200)
    expect(restore!.calls.permissions).toBe(0)
  })
})

describe('the service registers its own actions', () => {
  it('posts its manifest to /_/apps/register as the service customers', async () => {
    const seen: { url: string; auth: string; body: { name: string; actions: Record<string, unknown> } }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        auth: String(new Headers(init?.headers).get('authorization') ?? ''),
        body: JSON.parse(String(init?.body)),
      })
      return new Response(JSON.stringify({ app: { name: 'customers' } }), { status: 201, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const access = orgAccess('http://org.test/api', { JWT_SECRET: 'test-secret-32-chars-long-enough!' }, fetchImpl)
    expect(await registerWithOrg(access, { attempts: 1, log: () => {} })).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('http://org.test/_/apps/register')
    const claims = JSON.parse(Buffer.from(seen[0]!.auth.split('.')[1]!, 'base64url').toString()) as { sub: string; type: string }
    expect(claims).toMatchObject({ sub: 'customers', type: 'service' })
    expect(seen[0]!.body.name).toBe('customers')
    expect(Object.keys(seen[0]!.body.actions)).toEqual(Object.keys(CUSTOMERS_ACTIONS))
  })

  it('a refusal is reported, never thrown', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const access = orgAccess('http://org.test', { JWT_SECRET: 'test-secret-32-chars-long-enough!' }, fetchImpl)
    expect(await registerWithOrg(access, { attempts: 1, log: () => {} })).toBe(false)
  })
})
