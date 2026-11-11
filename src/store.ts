import { type FoldBase, FoldBaseError } from '@baseworks/foldbase'
import { CustomerEvents, LinkEvents, LOCKABLE_FIELDS } from '@baseworks/customers/events'
import type {
  Customer,
  CustomerRow,
  Address,
  CreateCustomerInput,
  UpdateCustomerInput,
  UpdateResult,
  ListCustomersOptions,
  CustomerKind,
  CustomerRole,
  LockableField,
  CustomerLink,
  LinkRow,
} from '@baseworks/customers'
import { generateShortId } from '@baseworks/core'

/**
 * The customers domain over foldbase. Unlike org-service (tenant = 'platform'),
 * customers are **genuinely per-org**, so every operation runs against
 * `fb.withTenant(orgId)` — real tenant isolation, not a column filter. Reads run
 * as the service's own `admin` identity; route handlers enforce end-user scoping
 * (the org membership check).
 */

export class StoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'StoreError'
  }
}

/** Map a foldbase optimistic-concurrency conflict (409) to a retryable StoreError. */
function onConflict(e: unknown): never {
  if (e instanceof FoldBaseError && e.status === 409) throw new StoreError(409, 'conflict', 'Customer changed concurrently — retry')
  throw e
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

const orNull = (s: string): string | null => (s === '' ? null : s)

// A set of roles is stored as `,customer,supplier,` so one role can be matched
// with `like '%,supplier,%'`. Rows from before 0.4.0 hold NULL: a customer.
const encodeRoles = (roles: readonly string[]): string => `,${[...new Set(roles)].sort().join(',')},`
const decodeRoles = (s: string | null | undefined): CustomerRole[] => {
  const roles = (s ?? '').split(',').filter(Boolean) as CustomerRole[]
  return roles.length ? roles : ['customer']
}
const decodeLocked = (s: string | null | undefined): LockableField[] =>
  parseJson<string[]>(s, []).filter((f): f is LockableField => (LOCKABLE_FIELDS as readonly string[]).includes(f))
const kindOf = (s: string | null | undefined): CustomerKind => (s === 'person' ? 'person' : 'company')

function toCustomer(r: CustomerRow): Customer {
  const address = parseJson<Address>(r.address, {})
  return {
    id: r.id,
    shortId: r.short_id,
    externalId: orNull(r.external_id),
    kind: kindOf(r.kind),
    roles: decodeRoles(r.roles),
    name: r.name,
    website: orNull(r.website ?? ''),
    lockedFields: decodeLocked(r.locked),
    email: orNull(r.email),
    phone: orNull(r.phone),
    taxId: orNull(r.tax_id),
    currency: orNull(r.currency),
    address: Object.keys(address).length ? address : null,
    metadata: parseJson<Record<string, unknown>>(r.metadata, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** The event payload that says everything a row says. */
function snapshotOf(r: CustomerRow) {
  return {
    externalId: r.external_id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    taxId: r.tax_id,
    currency: r.currency,
    address: r.address,
    metadata: r.metadata,
    kind: kindOf(r.kind),
    roles: encodeRoles(decodeRoles(r.roles)),
    website: r.website ?? '',
    locked: JSON.stringify(decodeLocked(r.locked)),
  }
}

export type Store = ReturnType<typeof createStore>

export function createStore(fb: FoldBase) {
  const scoped = (orgId: string) => {
    const t = fb.withTenant(orgId)
    return {
      q: t.withAuth({ uid: 'customers-service', role: 'admin' }),
      customers: t.catalog(CustomerEvents),
      links: t.catalog(LinkEvents),
      events: (streamId: string, fromVersion: number) => t.readStream(streamId, { fromVersion, limit: 500 }),
      version: (streamId: string) => t.streamVersion(streamId).then((v) => v.version),
    }
  }

  async function rowByRef(orgId: string, ref: string): Promise<CustomerRow | null> {
    const { q } = scoped(orgId)
    for (const field of ['id', 'short_id', 'external_id'] as const) {
      const res = await q.query<CustomerRow>('customers', { where: { [field]: { eq: ref } }, limit: 1 })
      if (res.rows[0]) return res.rows[0]
    }
    return null
  }

  async function listCustomers(orgId: string, opts: ListCustomersOptions = {}): Promise<Customer[]> {
    const { q } = scoped(orgId)
    // Rows from before 0.4.0 hold NULL in `kind` and `roles` and mean a
    // company that is a customer, so those two filters let NULL through.
    const where: unknown[] = []
    if (opts.kind === 'person') where.push({ kind: { eq: 'person' } })
    if (opts.kind === 'company') where.push({ or: [{ kind: { eq: 'company' } }, { kind: { eq: null } }] })
    if (opts.role === 'customer') where.push({ or: [{ roles: { like: '%,customer,%' } }, { roles: { eq: null } }] })
    else if (opts.role) where.push({ roles: { like: `%,${opts.role},%` } })
    if (opts.taxId) where.push({ tax_id: { eq: opts.taxId } })
    const res = await q.query<CustomerRow>('customers', {
      ...(where.length ? { where: (where.length === 1 ? where[0] : { and: where }) as never } : {}),
      sort: ['-created_at'],
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
    })
    return res.rows.map(toCustomer)
  }

  async function getCustomer(orgId: string, ref: string): Promise<Customer | null> {
    const row = await rowByRef(orgId, ref)
    return row ? toCustomer(row) : null
  }

  async function getByExternalId(orgId: string, externalId: string): Promise<Customer | null> {
    const { q } = scoped(orgId)
    const res = await q.query<CustomerRow>('customers', { where: { external_id: { eq: externalId } }, limit: 1 })
    return res.rows[0] ? toCustomer(res.rows[0]) : null
  }

  async function createCustomer(orgId: string, input: CreateCustomerInput, actor: string): Promise<Customer> {
    const { customers } = scoped(orgId)
    if (input.externalId) {
      const dup = await getByExternalId(orgId, input.externalId)
      if (dup) throw new StoreError(409, 'external_id_taken', `Customer with external_id '${input.externalId}' already exists`)
    }
    const id = CustomerEvents.newId()
    const now = Date.now()
    await customers.emit(id, 0, 'CustomerCreated', {
      externalId: input.externalId ?? '',
      name: input.name,
      email: input.email ?? '',
      phone: input.phone ?? '',
      taxId: input.taxId ?? '',
      currency: input.currency ?? '',
      address: input.address ? JSON.stringify(input.address) : '{}',
      metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
      kind: input.kind ?? 'company',
      roles: encodeRoles(input.roles?.length ? input.roles : ['customer']),
      website: input.website ?? '',
      locked: '[]',
      shortId: generateShortId(),
      at: now,
    }, { actor })
    return (await getCustomer(orgId, id))!
  }

  /**
   * Change a record. A field a person has locked is left as it is and named in
   * `skippedFields`; the rest of the write goes through. `unlock` is applied
   * before the write and `lock` after it, so "unlock and change" and "set and
   * lock" are each one request.
   */
  async function updateCustomer(orgId: string, ref: string, patch: UpdateCustomerInput, actor: string): Promise<UpdateResult> {
    const row = await rowByRef(orgId, ref)
    if (!row) throw new StoreError(404, 'not_found')
    const { customers, version } = scoped(orgId)
    const expected = await version(row.id) // OCC base — captured before the work

    const lockedNow = new Set(decodeLocked(row.locked))
    for (const f of patch.unlock ?? []) lockedNow.delete(f)
    // What this write may not touch: locked before it, and not unlocked by it.
    const held = new Set(lockedNow)
    const skippedFields = LOCKABLE_FIELDS.filter((f) => patch[f] !== undefined && held.has(f))
    const take = <K extends LockableField>(f: K): UpdateCustomerInput[K] | undefined =>
      held.has(f) ? undefined : patch[f]
    for (const f of patch.lock ?? []) lockedNow.add(f)
    const locked = JSON.stringify(LOCKABLE_FIELDS.filter((f) => lockedNow.has(f)))

    if (patch.externalId && patch.externalId !== row.external_id) {
      const dup = await getByExternalId(orgId, patch.externalId)
      if (dup) throw new StoreError(409, 'external_id_taken', `Customer with external_id '${patch.externalId}' already exists`)
    }
    const mergedMeta = patch.metadata
      ? { ...parseJson<Record<string, unknown>>(row.metadata, {}), ...patch.metadata }
      : parseJson<Record<string, unknown>>(row.metadata, {})
    const address = take('address')

    const before = snapshotOf(row)
    const after = {
      externalId: patch.externalId ?? row.external_id,
      name: take('name') ?? row.name,
      email: take('email') ?? row.email,
      phone: take('phone') ?? row.phone,
      taxId: take('taxId') ?? row.tax_id,
      currency: take('currency') ?? row.currency,
      address: address ? JSON.stringify(address) : row.address,
      metadata: JSON.stringify(mergedMeta),
      kind: patch.kind ?? before.kind,
      roles: patch.roles?.length ? encodeRoles(patch.roles) : before.roles,
      website: take('website') ?? before.website,
      locked,
    }
    // A write that only named locked fields changes nothing, and says so.
    const changed = (Object.keys(after) as Array<keyof typeof after>).some((k) => after[k] !== before[k])
    if (changed) {
      await customers.emit(row.id, expected, 'CustomerUpdated', { ...after, at: Date.now() }, { actor }).catch(onConflict)
    }
    return { customer: (await getCustomer(orgId, row.id))!, skippedFields }
  }

  async function archiveCustomer(orgId: string, ref: string, actor: string): Promise<void> {
    const row = await rowByRef(orgId, ref)
    if (!row) throw new StoreError(404, 'not_found')
    const { customers, version } = scoped(orgId)
    const expected = await version(row.id)
    await customers.emit(row.id, expected, 'CustomerArchived', {}, { actor }).catch(onConflict)
  }

  /**
   * Bring an archived record back. Archiving removed its row, so the record is
   * read from its own events and written back whole. By id only: an archived
   * record has no short id or external id to be found by.
   */
  async function restoreCustomer(orgId: string, id: string, actor: string): Promise<Customer> {
    const { customers, events } = scoped(orgId)
    let state: Record<string, unknown> | null = null
    let archived = false
    let createdAt = 0
    let shortId = ''
    let at = 0
    for (;;) {
      const page = await events(id, at)
      for (const e of page) {
        at = e.version
        if (e.streamType !== 'customer') throw new StoreError(404, 'not_found')
        if (e.type === 'CustomerArchived') { archived = true; continue }
        if (e.type === 'CustomerCreated') { createdAt = Number(e.payload['at']); shortId = String(e.payload['shortId']) }
        state = { ...(state ?? {}), ...e.payload }
        archived = false
      }
      if (page.length < 500) break
    }
    if (!state) throw new StoreError(404, 'not_found')
    if (!archived) throw new StoreError(409, 'not_archived', 'This record is not archived')
    const s = state as Record<string, string | undefined>
    if (s['externalId']) {
      const dup = await getByExternalId(orgId, s['externalId'])
      if (dup) throw new StoreError(409, 'external_id_taken', `Another record now has external_id '${s['externalId']}'`)
    }
    await customers.emit(id, at, 'CustomerRestored', {
      externalId: s['externalId'] ?? '',
      name: s['name'] ?? '',
      email: s['email'] ?? '',
      phone: s['phone'] ?? '',
      taxId: s['taxId'] ?? '',
      currency: s['currency'] ?? '',
      address: s['address'] ?? '{}',
      metadata: s['metadata'] ?? '{}',
      kind: kindOf(s['kind']),
      roles: encodeRoles(decodeRoles(s['roles'])),
      website: s['website'] ?? '',
      locked: s['locked'] ?? '[]',
      shortId,
      createdAt,
      at: Date.now(),
    }, { actor }).catch(onConflict)
    return (await getCustomer(orgId, id))!
  }

  // ── links: which person is at which company ───────────────────────────────

  async function toLinks(orgId: string, rows: LinkRow[]): Promise<CustomerLink[]> {
    if (!rows.length) return []
    const { q } = scoped(orgId)
    const ids = [...new Set(rows.flatMap((r) => [r.person_id, r.company_id]))]
    const parties = await q.query<CustomerRow>('customers', { where: { id: { in: ids } }, limit: ids.length })
    const byId = new Map(parties.rows.map((r) => [r.id, { id: r.id, shortId: r.short_id, name: r.name }]))
    // A link whose other side is archived is not shown; it returns with the record.
    return rows.flatMap((r) => {
      const person = byId.get(r.person_id)
      const company = byId.get(r.company_id)
      return person && company ? [{ id: r.id, person, company, title: orNull(r.title), createdAt: r.created_at }] : []
    })
  }

  async function listLinks(orgId: string, ref: string): Promise<CustomerLink[]> {
    const row = await rowByRef(orgId, ref)
    if (!row) throw new StoreError(404, 'not_found')
    const { q } = scoped(orgId)
    const res = await q.query<LinkRow>('customer_links', {
      where: { or: [{ person_id: { eq: row.id } }, { company_id: { eq: row.id } }] },
      sort: ['created_at'],
      limit: 500,
    })
    return toLinks(orgId, res.rows)
  }

  async function addLink(orgId: string, ref: string, input: { to: string; title?: string }, actor: string): Promise<CustomerLink> {
    const [a, b] = await Promise.all([rowByRef(orgId, ref), rowByRef(orgId, input.to)])
    if (!a) throw new StoreError(404, 'not_found')
    if (!b) throw new StoreError(404, 'link_target_not_found', `No record '${input.to}'`)
    const person = [a, b].find((r) => kindOf(r.kind) === 'person')
    const company = [a, b].find((r) => kindOf(r.kind) === 'company')
    if (!person || !company) throw new StoreError(422, 'link_needs_person_and_company', 'A link joins one person and one company')
    const { q, links } = scoped(orgId)
    const dup = await q.query<LinkRow>('customer_links', {
      where: { and: [{ person_id: { eq: person.id } }, { company_id: { eq: company.id } }] },
      limit: 1,
    })
    if (dup.rows[0]) throw new StoreError(409, 'link_exists', 'These two are already linked')
    const id = LinkEvents.newId()
    await links.emit(id, 0, 'LinkCreated', {
      personId: person.id, companyId: company.id, title: input.title ?? '', at: Date.now(),
    }, { actor })
    return (await linkOf(orgId, a.id, id))!
  }

  /** A link, only if `customerId` is one of its two sides. */
  async function linkOf(orgId: string, customerId: string, linkId: string): Promise<CustomerLink | null> {
    const { q } = scoped(orgId)
    const res = await q.query<LinkRow>('customer_links', { where: { id: { eq: linkId } }, limit: 1 })
    const row = res.rows[0]
    if (!row || (row.person_id !== customerId && row.company_id !== customerId)) return null
    return (await toLinks(orgId, [row]))[0] ?? null
  }

  async function ownLink(orgId: string, ref: string, linkId: string) {
    const row = await rowByRef(orgId, ref)
    if (!row) throw new StoreError(404, 'not_found')
    if (!(await linkOf(orgId, row.id, linkId))) throw new StoreError(404, 'link_not_found')
    return row
  }

  async function retitleLink(orgId: string, ref: string, linkId: string, title: string, actor: string): Promise<CustomerLink> {
    const row = await ownLink(orgId, ref, linkId)
    const { links, version } = scoped(orgId)
    await links.emit(linkId, await version(linkId), 'LinkRetitled', { title, at: Date.now() }, { actor }).catch(onConflict)
    return (await linkOf(orgId, row.id, linkId))!
  }

  async function removeLink(orgId: string, ref: string, linkId: string, actor: string): Promise<void> {
    await ownLink(orgId, ref, linkId)
    const { links, version } = scoped(orgId)
    await links.emit(linkId, await version(linkId), 'LinkRemoved', {}, { actor }).catch(onConflict)
  }

  return {
    listCustomers, getCustomer, getByExternalId, createCustomer, updateCustomer, archiveCustomer, restoreCustomer,
    listLinks, addLink, retitleLink, removeLink,
  }
}
