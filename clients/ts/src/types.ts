// Customer domain types. Foldbase-native: read-model row shape (snake_case, as
// stored) and the REST DTO (camelCase, as API + CLI consume).

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
  created_at: number
  updated_at: number
}

// ── REST DTO (camelCase — API responses + CLI input) ──────────────────────────

export interface Address {
  line1?: string
  line2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

export interface Customer {
  id: string
  shortId: string
  /** Optional caller-side id (e.g. the id in the consumer's own system). */
  externalId: string | null
  name: string
  email: string | null
  phone: string | null
  taxId: string | null
  currency: string | null
  address: Address | null
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface CreateCustomerInput {
  name: string
  externalId?: string
  email?: string
  phone?: string
  taxId?: string
  currency?: string
  address?: Address
  metadata?: Record<string, unknown>
}

export interface UpdateCustomerInput {
  name?: string
  externalId?: string
  email?: string
  phone?: string
  taxId?: string
  currency?: string
  address?: Address
  metadata?: Record<string, unknown>
}
