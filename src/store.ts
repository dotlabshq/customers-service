import { type FoldBase, FoldBaseError } from '@baseworks/foldbase'
import { CustomerEvents } from '@baseworks/customers/events'
import type {
  Customer,
  CustomerRow,
  Address,
  CreateCustomerInput,
  UpdateCustomerInput,
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

function toCustomer(r: CustomerRow): Customer {
  const address = parseJson<Address>(r.address, {})
  return {
    id: r.id,
    shortId: r.short_id,
    externalId: orNull(r.external_id),
    name: r.name,
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

export type Store = ReturnType<typeof createStore>

export function createStore(fb: FoldBase) {
  const scoped = (orgId: string) => {
    const t = fb.withTenant(orgId)
    return {
      q: t.withAuth({ uid: 'customers-service', role: 'admin' }),
      customers: t.catalog(CustomerEvents),
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

  async function listCustomers(orgId: string, opts: { limit?: number; offset?: number } = {}): Promise<Customer[]> {
    const { q } = scoped(orgId)
    const res = await q.query<CustomerRow>('customers', {
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
      shortId: generateShortId(),
      at: now,
    }, { actor })
    return (await getCustomer(orgId, id))!
  }

  async function updateCustomer(orgId: string, ref: string, patch: UpdateCustomerInput, actor: string): Promise<Customer> {
    const row = await rowByRef(orgId, ref)
    if (!row) throw new StoreError(404, 'not_found')
    const { customers, version } = scoped(orgId)
    const expected = await version(row.id) // OCC base — captured before the work

    if (patch.externalId && patch.externalId !== row.external_id) {
      const dup = await getByExternalId(orgId, patch.externalId)
      if (dup) throw new StoreError(409, 'external_id_taken', `Customer with external_id '${patch.externalId}' already exists`)
    }
    const mergedMeta = patch.metadata
      ? { ...parseJson<Record<string, unknown>>(row.metadata, {}), ...patch.metadata }
      : parseJson<Record<string, unknown>>(row.metadata, {})

    await customers.emit(row.id, expected, 'CustomerUpdated', {
      externalId: patch.externalId ?? row.external_id,
      name: patch.name ?? row.name,
      email: patch.email ?? row.email,
      phone: patch.phone ?? row.phone,
      taxId: patch.taxId ?? row.tax_id,
      currency: patch.currency ?? row.currency,
      address: patch.address ? JSON.stringify(patch.address) : row.address,
      metadata: JSON.stringify(mergedMeta),
      at: Date.now(),
    }, { actor }).catch(onConflict)
    return (await getCustomer(orgId, row.id))!
  }

  async function archiveCustomer(orgId: string, ref: string, actor: string): Promise<void> {
    const row = await rowByRef(orgId, ref)
    if (!row) throw new StoreError(404, 'not_found')
    const { customers, version } = scoped(orgId)
    const expected = await version(row.id)
    await customers.emit(row.id, expected, 'CustomerArchived', {}, { actor }).catch(onConflict)
  }

  return { listCustomers, getCustomer, getByExternalId, createCustomer, updateCustomer, archiveCustomer }
}
