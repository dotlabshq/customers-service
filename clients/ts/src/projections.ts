import { defineProjection, type PolicyDef } from '@baseworks/foldbase'
import { CustomerEvents } from './events.js'

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
  })),
  CustomerArchived: on.CustomerArchived.delete(),
}))

export const PROJECTIONS = [readCustomers] as const

/** Permissive policy for the service's own `admin` identity (see ADR 0001). */
export const POLICIES: PolicyDef[] = [{ name: 'customers', role: 'admin' }]
