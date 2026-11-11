/**
 * Reading at scale: several records by id, search, a cursor that walks a
 * directory without skipping or repeating, and the feed of what changed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootTestFoldBase, fakeOrgService, makeTestApp, newOrgId, type TestFoldBase } from './setup.js'

type App = Awaited<ReturnType<typeof makeTestApp>>
type Customer = { id: string; name: string }
type Page = { customers: Customer[]; next_cursor: string | null }
type Changes = { changes: { seq: number; type: string; id: string; actor: string; at: number }[]; cursor: string }

let fb: TestFoldBase
let app: App
let orgId: string
let restore: () => void

const json = async <T>(res: Response) => (await res.json()) as T
const make = async (body: Record<string, unknown>) =>
  (await json<{ customer: Customer }>(await app.post('/api/customers', body))).customer
const page = async (query: string) => json<Page>(await app.get(`/api/customers${query}`))

beforeAll(async () => { fb = await bootTestFoldBase() }, 30_000)
afterAll(async () => { await fb.stop() })
beforeEach(async () => { orgId = newOrgId(); app = await makeTestApp(fb, orgId); restore = fakeOrgService({ [orgId]: 'owner' }) })
afterEach(() => restore())

describe('several records by id', () => {
  it('answers the ones that exist, in one request', async () => {
    const a = await make({ name: 'Acme' })
    const b = await make({ name: 'Beta' })
    await make({ name: 'Gamma' })
    const res = await page(`?ids=${a.id},${b.id},no-such-id,${a.id}`)
    expect(res.customers.map((c) => c.name).sort()).toEqual(['Acme', 'Beta'])
    expect((await page('?ids=')).customers).toEqual([])
  })

  it('refuses more than 100', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`).join(',')
    const res = await app.get(`/api/customers?ids=${ids}`)
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ error: 'too_many_ids' })
  })

  it('never reaches into another organization', async () => {
    const a = await make({ name: 'Acme' })
    const other = newOrgId()
    restore(); restore = fakeOrgService({ [orgId]: 'owner', [other]: 'owner' })
    expect((await json<Page>(await app.get(`/api/customers?ids=${a.id}`, { org: other }))).customers).toEqual([])
  })
})

describe('search', () => {
  it('finds text in name, email, website, tax id and external id, with the other filters', async () => {
    await make({ name: 'Acme GmbH', email: 'billing@acme.test' })
    await make({ name: 'Beta', website: 'beta-acme.example' })
    await make({ name: 'Gamma', tax_id: '99ACME11' })
    await make({ name: 'Delta', external_id: 'crm-acme-7' })
    await make({ name: 'Ada Acme', kind: 'person' })
    await make({ name: 'Other' })
    const found = async (q: string) => (await page(q)).customers.map((c) => c.name).sort()
    expect(await found('?q=acme')).toEqual(['Acme GmbH', 'Ada Acme', 'Beta', 'Delta', 'Gamma'])
    expect(await found('?q=acme&kind=person')).toEqual(['Ada Acme'])
    expect(await found('?q=nothing-like-this')).toEqual([])
  })

  it('a wildcard is not a search for everything', async () => {
    await make({ name: 'Acme' })
    expect((await page('?q=zz%25')).customers).toEqual([])
    // Only wildcards is no search at all: the plain list.
    expect((await page('?q=%25')).customers).toHaveLength(1)
  })
})

describe('a cursor walks the whole directory', () => {
  it('page by page, newest first, each record once, and ends with null', async () => {
    const made: string[] = []
    for (let i = 0; i < 7; i++) made.push((await make({ name: `C${i}` })).id)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const p: Page = await page(`?limit=3${cursor ? `&cursor=${cursor}` : ''}`)
      seen.push(...p.customers.map((c) => c.id))
      cursor = p.next_cursor
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(seen).toEqual([...made].reverse())
  })

  it('a record added mid-walk does not shift the pages', async () => {
    for (let i = 0; i < 4; i++) await make({ name: `C${i}` })
    const first = await page('?limit=2')
    await make({ name: 'Late' })
    const second = await page(`?limit=2&cursor=${first.next_cursor}`)
    expect([...first.customers, ...second.customers].map((c) => c.name)).toEqual(['C3', 'C2', 'C1', 'C0'])
    expect(second.next_cursor).toBeNull()
  })

  it('a full last page still ends, and a cursor nobody gave is 400', async () => {
    await make({ name: 'A' }); await make({ name: 'B' })
    expect((await page('?limit=2')).next_cursor).toBeNull()
    const res = await app.get('/api/customers?cursor=not-a-cursor')
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ error: 'invalid_cursor' })
  })

  it('offset still works for callers that use it', async () => {
    for (let i = 0; i < 3; i++) await make({ name: `C${i}` })
    expect((await page('?limit=1&offset=1')).customers.map((c) => c.name)).toEqual(['C1'])
  })
})

describe('the change feed', () => {
  it('says what happened, in order, and continues from its cursor', async () => {
    const a = await make({ name: 'Acme' })
    await app.patch(`/api/customers/${a.id}`, { name: 'Acme GmbH' })
    const first = await json<Changes>(await app.get('/api/changes'))
    expect(first.changes.map((c) => [c.type, c.id])).toEqual([['CustomerCreated', a.id], ['CustomerUpdated', a.id]])
    expect(first.changes[0]).toMatchObject({ actor: 'user-test-001' })
    expect(first.changes[1]!.seq).toBeGreaterThan(first.changes[0]!.seq)

    // Nothing new: no changes, and the cursor stays where it was.
    expect(await json<Changes>(await app.get(`/api/changes?after=${first.cursor}`))).toEqual({ changes: [], cursor: first.cursor })

    await app.del(`/api/customers/${a.id}`)
    await app.post(`/api/customers/${a.id}/restore`, {})
    const next = await json<Changes>(await app.get(`/api/changes?after=${first.cursor}`))
    expect(next.changes.map((c) => c.type)).toEqual(['CustomerArchived', 'CustomerRestored'])
  })

  it('pages with limit, and keeps links in a feed of their own', async () => {
    const acme = await make({ name: 'Acme' })
    const ada = await make({ name: 'Ada', kind: 'person' })
    const { link } = await json<{ link: { id: string } }>(await app.post(`/api/customers/${acme.id}/links`, { to: ada.id }))
    const one = await json<Changes>(await app.get('/api/changes?limit=1'))
    expect(one.changes).toHaveLength(1)
    const rest = await json<Changes>(await app.get(`/api/changes?after=${one.cursor}`))
    expect(rest.changes.map((c) => c.id)).toEqual([ada.id])
    const links = await json<Changes>(await app.get('/api/changes?entity=link'))
    expect(links.changes.map((c) => [c.type, c.id])).toEqual([['LinkCreated', link.id]])
  })

  it('is one organization\'s, needs customer.read, and refuses a bad cursor or entity', async () => {
    await make({ name: 'Acme' })
    const other = newOrgId()
    restore(); restore = fakeOrgService({ [orgId]: 'viewer', [other]: 'owner' })
    expect((await json<Changes>(await app.get('/api/changes', { org: other }))).changes).toEqual([])
    expect((await app.get('/api/changes')).status).toBe(200)
    expect((await app.get('/api/changes?after=abc')).status).toBe(400)
    expect((await app.get('/api/changes?entity=invoice')).status).toBe(400)
    restore(); restore = fakeOrgService({ [orgId]: 'owner' }, { registered: false })
    expect((await app.get('/api/changes')).status).toBe(403)
  })
})
