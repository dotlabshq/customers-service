import { defineProjection, type PolicyDef } from '@baseworks/foldbase'
import { CustomerEvents, LinkEvents } from './events.js'

/**
 * Read-model definition registered on boot (idempotent, like a migration).
 * Columns are inferred from event field types; `updated_at` is foldbase's
 * server-maintained spine and is never declared. Archive deletes the row — the
 * events remain the durable audit trail. The service is the authorization layer
 * (end-user scoping enforced in the route handlers), so the read policy is
 * permissive for the service's own `admin` identity.
 */
export const readCustomers = defineProjection('customers', CustomerEvents, (on) => ({
  CustomerCreated: on.CustomerCreated.upsert((e) => ({
    external_id: e.externalId,
    name: e.name,
    email: e.email,
    phone: e.phone,
    tax_id: e.taxId,
    currency: e.currency,
    address: e.address,
    metadata: e.metadata,
    kind: e.kind,
    roles: e.roles,
    website: e.website,
    locked: e.locked,
    short_id: e.shortId,
    created_at: e.at,
  })),
  CustomerUpdated: on.CustomerUpdated.upsert((e) => ({
    external_id: e.externalId,
    name: e.name,
    email: e.email,
    phone: e.phone,
    tax_id: e.taxId,
    currency: e.currency,
    address: e.address,
    metadata: e.metadata,
    kind: e.kind,
    roles: e.roles,
    website: e.website,
    locked: e.locked,
  })),
  CustomerArchived: on.CustomerArchived.delete(),
  CustomerRestored: on.CustomerRestored.upsert((e) => ({
    external_id: e.externalId,
    name: e.name,
    email: e.email,
    phone: e.phone,
    tax_id: e.taxId,
    currency: e.currency,
    address: e.address,
    metadata: e.metadata,
    kind: e.kind,
    roles: e.roles,
    website: e.website,
    locked: e.locked,
    short_id: e.shortId,
    created_at: e.createdAt,
  })),
}))

/** Who is at which company. Removing a link deletes its row. */
export const readLinks = defineProjection('customer_links', LinkEvents, (on) => ({
  LinkCreated: on.LinkCreated.upsert((e) => ({
    person_id: e.personId,
    company_id: e.companyId,
    title: e.title,
    created_at: e.at,
  })),
  LinkRetitled: on.LinkRetitled.upsert((e) => ({ title: e.title })),
  LinkRemoved: on.LinkRemoved.delete(),
}))

export const PROJECTIONS = [readCustomers, readLinks] as const

/** Permissive policy for the service's own `admin` identity (see ADR 0001). */
export const POLICIES: PolicyDef[] = [
  { name: 'customers', role: 'admin' },
  { name: 'customer_links', role: 'admin' },
]
