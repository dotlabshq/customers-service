/**
 * The record since 0.4.0: a company or a person, with roles and a website;
 * fields a person can lock; archived records that come back; and links that
 * say which person is at which company.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FoldBase } from '@baseworks/foldbase'
import {
  bootTestFoldBase, fakeOrgService, makeServiceToken, makeTestApp, newOrgId, type TestFoldBase,
} from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
type Customer = {
  id: string; shortId: string; name: string; kind: string; roles: string[]; website: string | null
  email: string | null; lockedFields: string[]; externalId: string | null
}
type Link = { id: string; title: string | null; person: { id: string; name: string }; company: { id: string; name: string } }

let fb: TestFoldBase
let app: App
let orgId: string
let restore: () => void

const json = async <T>(res: Response) => (await res.json()) as T
const make = async (body: Record<string, unknown>) =>
  (await json<{ customer: Customer }>(await app.post('/api/customers', body))).customer
const names = async (query: string) =>
  (await json<{ customers: Customer[] }>(await app.get(`/api/customers${query}`))).customers.map((c) => c.name).sort()

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => { orgId = newOrgId(); app = await makeTestApp(fb, orgId); restore = fakeOrgService({ [orgId]: 'owner' }) })
afterEach(() => restore())

describe('kind, roles and website', () => {
  it('a record is a company that is a customer unless it says otherwise', async () => {
    const c = await make({ name: 'Acme' })
    expect(c).toMatchObject({ kind: 'company', roles: ['customer'], website: null, lockedFields: [] })
  })

  it('one record can be a customer and a supplier, and is found by either role, by kind and by tax id', async () => {
    await make({ name: 'Acme', roles: ['supplier', 'customer'], website: 'acme.test', taxId: '1234567890' })
    await make({ name: 'Beta', roles: ['supplier'] })
    await make({ name: 'Ada', kind: 'person', roles: ['employee'] })
    expect(await names('?role=supplier')).toEqual(['Acme', 'Beta'])
    expect(await names('?role=customer')).toEqual(['Acme'])
    expect(await names('?kind=person')).toEqual(['Ada'])
    expect(await names('?kind=company')).toEqual(['Acme', 'Beta'])
    expect(await names('?kind=company&role=supplier')).toEqual(['Acme', 'Beta'])
    expect(await names('?tax_id=1234567890')).toEqual(['Acme'])
    expect((await app.get('/api/customers?kind=robot')).status).toBe(400)
    expect((await app.get('/api/customers?role=boss')).status).toBe(400)
  })

  it('roles are replaced as a set, and an empty set is refused', async () => {
    const c = await make({ name: 'Acme' })
    const res = await json<{ customer: Customer }>(await app.patch(`/api/customers/${c.id}`, { roles: ['partner', 'supplier'], website: 'https://acme.test' }))
    expect(res.customer.roles).toEqual(['partner', 'supplier'])
    expect(res.customer.website).toBe('https://acme.test')
    expect((await app.patch(`/api/customers/${c.id}`, { roles: [] })).status).toBe(400)
  })
})

describe('a locked field is left as the person set it', () => {
  it('a later write skips it, says so, and applies the rest', async () => {
    const c = await make({ name: 'Acme', email: 'a@acme.test' })
    const locked = await json<{ customer: Customer; skippedFields: string[] }>(
      await app.patch(`/api/customers/${c.id}`, { name: 'Acme GmbH', lock: ['name'] }))
    // Set and lock in one request: the value lands, then the lock.
    expect(locked.customer).toMatchObject({ name: 'Acme GmbH', lockedFields: ['name'] })
    expect(locked.skippedFields).toEqual([])

    const sync = await json<{ customer: Customer; skippedFields: string[] }>(
      await app.patch(`/api/customers/${c.id}`, { name: 'ACME (import)', email: 'new@acme.test' }, { token: makeServiceToken('importer'), org: orgId }))
    expect(sync.skippedFields).toEqual(['name'])
    expect(sync.customer).toMatchObject({ name: 'Acme GmbH', email: 'new@acme.test' })
  })

  it('a write that names only locked fields changes nothing and still answers 200', async () => {
    const c = await make({ name: 'Acme' })
    await app.patch(`/api/customers/${c.id}`, { lock: ['name'] })
    const res = await app.patch(`/api/customers/${c.id}`, { name: 'Other' })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ customer: { name: 'Acme' }, skippedFields: ['name'] })
  })

  it('unlock and change is one request', async () => {
    const c = await make({ name: 'Acme' })
    await app.patch(`/api/customers/${c.id}`, { lock: ['name'] })
    const res = await json<{ customer: Customer; skippedFields: string[] }>(
      await app.patch(`/api/customers/${c.id}`, { name: 'Acme AG', unlock: ['name'] }))
    expect(res).toMatchObject({ customer: { name: 'Acme AG', lockedFields: [] }, skippedFields: [] })
  })

  it('only a person locks or unlocks', async () => {
    const c = await make({ name: 'Acme' })
    const service = { token: makeServiceToken('importer'), org: orgId }
    expect((await app.patch(`/api/customers/${c.id}`, { lock: ['name'] }, service)).status).toBe(403)
    await app.patch(`/api/customers/${c.id}`, { lock: ['name'] })
    const res = await app.patch(`/api/customers/${c.id}`, { unlock: ['name'] }, service)
    expect(await json(res)).toMatchObject({ error: 'person_only' })
  })
})

describe('an archived record comes back', () => {
  it('whole, under the same id and short id, with its locks', async () => {
    const c = await make({ name: 'Acme', kind: 'company', roles: ['supplier'], website: 'acme.test', externalId: 'crm-1' })
    await app.patch(`/api/customers/${c.id}`, { email: 'a@acme.test', lock: ['email'] })
    expect((await app.del(`/api/customers/${c.id}`)).status).toBe(204)
    expect((await app.get(`/api/customers/${c.id}`)).status).toBe(404)

    const res = await app.post(`/api/customers/${c.id}/restore`, {})
    expect(res.status).toBe(200)
    const back = (await json<{ customer: Customer }>(res)).customer
    expect(back).toMatchObject({
      id: c.id, shortId: c.shortId, name: 'Acme', roles: ['supplier'], website: 'acme.test',
      externalId: 'crm-1', email: 'a@acme.test', lockedFields: ['email'],
    })
    expect(await names('')).toEqual(['Acme'])
  })

  it('a record that is not archived is 409, an unknown id 404', async () => {
    const c = await make({ name: 'Acme' })
    expect(await json(await app.post(`/api/customers/${c.id}/restore`, {}))).toMatchObject({ error: 'not_archived' })
    expect((await app.post('/api/customers/no-such-id/restore', {})).status).toBe(404)
  })

  it('is refused while another record holds its external id', async () => {
    const c = await make({ name: 'Acme', externalId: 'crm-1' })
    await app.del(`/api/customers/${c.id}`)
    await make({ name: 'Acme again', externalId: 'crm-1' })
    const res = await app.post(`/api/customers/${c.id}/restore`, {})
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ error: 'external_id_taken' })
  })

  it('can be archived and restored again', async () => {
    const c = await make({ name: 'Acme' })
    for (let i = 0; i < 2; i++) {
      await app.del(`/api/customers/${c.id}`)
      expect((await app.post(`/api/customers/${c.id}/restore`, {})).status).toBe(200)
    }
  })
})

describe('a person is linked to a company', () => {
  it('from either side, with a title, and both sides see it', async () => {
    const acme = await make({ name: 'Acme' })
    const ada = await make({ name: 'Ada', kind: 'person' })
    const res = await app.post(`/api/customers/${acme.id}/links`, { to: ada.shortId, title: 'CFO' })
    expect(res.status).toBe(201)
    const link = (await json<{ link: Link }>(res)).link
    expect(link).toMatchObject({ title: 'CFO', person: { id: ada.id, name: 'Ada' }, company: { id: acme.id, name: 'Acme' } })
    for (const side of [acme, ada]) {
      const { links } = await json<{ links: Link[] }>(await app.get(`/api/customers/${side.id}/links`))
      expect(links.map((l) => l.id)).toEqual([link.id])
    }
  })

  it('needs one person and one company, and each pair once', async () => {
    const acme = await make({ name: 'Acme' })
    const beta = await make({ name: 'Beta' })
    const ada = await make({ name: 'Ada', kind: 'person' })
    expect(await json(await app.post(`/api/customers/${acme.id}/links`, { to: beta.id }))).toMatchObject({ error: 'link_needs_person_and_company' })
    expect((await app.post(`/api/customers/${acme.id}/links`, { to: 'nobody' })).status).toBe(404)
    expect((await app.post(`/api/customers/${ada.id}/links`, { to: acme.id })).status).toBe(201)
    expect(await json(await app.post(`/api/customers/${acme.id}/links`, { to: ada.id }))).toMatchObject({ error: 'link_exists' })
    // A person can be at more than one company.
    expect((await app.post(`/api/customers/${ada.id}/links`, { to: beta.id, title: 'Advisor' })).status).toBe(201)
  })

  it('a title changes, a link is removed, and only through a record that is one of its sides', async () => {
    const acme = await make({ name: 'Acme' })
    const beta = await make({ name: 'Beta' })
    const ada = await make({ name: 'Ada', kind: 'person' })
    const { link } = await json<{ link: Link }>(await app.post(`/api/customers/${acme.id}/links`, { to: ada.id }))
    expect(link.title).toBeNull()
    expect((await app.patch(`/api/customers/${beta.id}/links/${link.id}`, { title: 'x' })).status).toBe(404)
    const retitled = await json<{ link: Link }>(await app.patch(`/api/customers/${ada.id}/links/${link.id}`, { title: 'Purchasing' }))
    expect(retitled.link.title).toBe('Purchasing')
    expect((await app.del(`/api/customers/${acme.id}/links/${link.id}`)).status).toBe(204)
    expect((await json<{ links: Link[] }>(await app.get(`/api/customers/${ada.id}/links`))).links).toEqual([])
  })

  it('a link to an archived record is not shown, and returns with it', async () => {
    const acme = await make({ name: 'Acme' })
    const ada = await make({ name: 'Ada', kind: 'person' })
    await app.post(`/api/customers/${acme.id}/links`, { to: ada.id, title: 'CFO' })
    await app.del(`/api/customers/${ada.id}`)
    expect((await json<{ links: Link[] }>(await app.get(`/api/customers/${acme.id}/links`))).links).toEqual([])
    await app.post(`/api/customers/${ada.id}/restore`, {})
    expect((await json<{ links: Link[] }>(await app.get(`/api/customers/${acme.id}/links`))).links).toHaveLength(1)
  })

  it('a viewer sees links and cannot make one', async () => {
    const acme = await make({ name: 'Acme' })
    const ada = await make({ name: 'Ada', kind: 'person' })
    restore(); restore = fakeOrgService({ [orgId]: 'viewer' })
    expect((await app.get(`/api/customers/${acme.id}/links`)).status).toBe(200)
    expect((await app.post(`/api/customers/${acme.id}/links`, { to: ada.id })).status).toBe(403)
  })
})

describe('a record written before 0.4.0', () => {
  // Its events carry none of the new fields, so the read model holds NULL.
  const legacy = async (name: string, then: Array<{ type: string; payload: Record<string, unknown> }> = []) => {
    const raw = new FoldBase({ baseUrl: fb.base, token: fb.svcToken, tenant: orgId })
    const id = `legacy-${Math.random().toString(36).slice(2)}`
    const old = { externalId: '', name, email: '', phone: '', taxId: '', currency: '', address: '{}', metadata: '{}' }
    await raw.append(id, 0, [
      { type: 'CustomerCreated', streamId: id, actor: 'u', payload: { ...old, shortId: `s${id.slice(-6)}`, at: 1 } },
      ...then.map((e) => ({ ...e, streamId: id, actor: 'u' })),
    ], { streamType: 'customer' })
    return id
  }

  it('reads as a company that is a customer, and is found as one', async () => {
    const id = await legacy('Old Co')
    const c = (await json<{ customer: Customer }>(await app.get(`/api/customers/${id}`))).customer
    expect(c).toMatchObject({ kind: 'company', roles: ['customer'], website: null, lockedFields: [] })
    expect(await names('?kind=company')).toEqual(['Old Co'])
    expect(await names('?role=customer')).toEqual(['Old Co'])
    expect(await names('?kind=person')).toEqual([])
    expect(await names('?role=supplier')).toEqual([])
  })

  it('takes the new fields on its next update', async () => {
    const id = await legacy('Old Co')
    const res = await json<{ customer: Customer }>(await app.patch(`/api/customers/${id}`, { roles: ['supplier'], lock: ['name'] }))
    expect(res.customer).toMatchObject({ name: 'Old Co', kind: 'company', roles: ['supplier'], lockedFields: ['name'] })
  })

  it('comes back if it was archived then', async () => {
    const id = await legacy('Old Co', [{ type: 'CustomerArchived', payload: {} }])
    const res = await app.post(`/api/customers/${id}/restore`, {})
    expect(res.status).toBe(200)
    expect((await json<{ customer: Customer }>(res)).customer).toMatchObject({ name: 'Old Co', kind: 'company', roles: ['customer'] })
  })
})
