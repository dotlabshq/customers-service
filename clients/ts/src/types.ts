// Customer domain types: the read-model row as stored, and the REST DTO.
// Both are snake_case; the wire was camelCase before 0.6.0 of the service.

// ── read-model row (snake_case — foldbase read_customers table) ───────────────

export interface CustomerRow {
  id: string
  short_id: string
  external_id: string
  name: string
  email: string
  phone: string
  tax_id: string
  currency: string
  address: string // JSON string
  metadata: string // JSON string
  /** NULL on rows written before 0.4.0. */
  kind: string | null
  roles: string | null
  website: string | null
  locked: string | null // JSON array string
  created_at: number
  updated_at: number
}

export interface LinkRow {
  id: string
  person_id: string
  company_id: string
  title: string
  created_at: number
  updated_at: number
}

// ── REST DTO (snake_case, as every service in the realm speaks: ADR-043) ──────────────────────────

export interface Address {
  line1?: string
  line2?: string
  city?: string
  state?: string
  postal_code?: string
  country?: string
}

export type CustomerKind = 'company' | 'person'
/** What the party is to the organization. One record can be several. */
export type CustomerRole = 'customer' | 'supplier' | 'employee' | 'partner'
/** A field a person may lock, so later writes leave it as it is. */
export type LockableField = 'name' | 'email' | 'phone' | 'website' | 'tax_id' | 'currency' | 'address'

export interface Customer {
  id: string
  short_id: string
  /** The id in the user's own third-party system. One per record; anything more belongs in `metadata`. */
  external_id: string | null
  kind: CustomerKind
  roles: CustomerRole[]
  name: string
  website: string | null
  /** Fields a person has locked. A write that names one skips it. */
  locked_fields: LockableField[]
  email: string | null
  phone: string | null
  tax_id: string | null
  currency: string | null
  address: Address | null
  metadata: Record<string, unknown>
  created_at: number
  updated_at: number
}

export interface CreateCustomerInput {
  name: string
  /** Default `company`. */
  kind?: CustomerKind
  /** Default `['customer']`. */
  roles?: CustomerRole[]
  website?: string
  external_id?: string
  email?: string
  phone?: string
  tax_id?: string
  currency?: string
  address?: Address
  metadata?: Record<string, unknown>
}

export interface UpdateCustomerInput {
  name?: string
  kind?: CustomerKind
  roles?: CustomerRole[]
  website?: string
  /** Lock these fields (after this write's own values are applied). A person only. */
  lock?: LockableField[]
  /** Unlock these fields (before this write is applied). A person only. */
  unlock?: LockableField[]
  external_id?: string
  email?: string
  phone?: string
  tax_id?: string
  currency?: string
  address?: Address
  metadata?: Record<string, unknown>
}

/** What an update did: the record, and the locked fields it left alone. */
export interface UpdateResult {
  customer: Customer
  skipped_fields: LockableField[]
}

export interface ListCustomersOptions {
  limit?: number
  /** Skip this many. Ignored when `cursor` is given; prefer `cursor` for walking a whole directory. */
  offset?: number
  /** Where the previous page ended (`next_cursor`). */
  cursor?: string
  /** Text to find in name, email, website, tax id or external id. */
  q?: string
  kind?: CustomerKind
  role?: CustomerRole
  tax_id?: string
}

/** One side of a link, enough to show it. */
export interface LinkParty {
  id: string
  short_id: string
  name: string
}

/** A person's place at a company. */
export interface CustomerLink {
  id: string
  person: LinkParty
  company: LinkParty
  /** What the person is there (`CFO`, `Purchasing`); null if not said. */
  title: string | null
  created_at: number
}

/** One page of a list, and where the next one starts (null at the end). */
export interface CustomerPage {
  customers: Customer[]
  next_cursor: string | null
}

/**
 * One thing that happened to a record or a link. The feed says *that* it
 * changed; read the record itself (`getMany`) for what it is now.
 */
export interface CustomerChange {
  /** Position in the organization's feed. */
  seq: number
  /** The event: `CustomerCreated`, `CustomerUpdated`, `CustomerArchived`, `CustomerRestored`, `LinkCreated`, … */
  type: string
  /** The record's id, or the link's. */
  id: string
  /** Who did it: a user id or a service name. */
  actor: string
  at: number
}

export interface ChangesPage {
  changes: CustomerChange[]
  /** Pass as `after` next time. Unchanged when nothing new happened. */
  cursor: string
}
