import { z } from 'zod'
import { defineAggregate } from '@baseworks/foldbase'

/**
 * Event catalog — the single source of truth for customers-service payloads.
 * One aggregate: `customer`, a per-org customer directory entry.
 *
 * Foldbase infers read-model column types from event field types, and a column
 * fed two conflicting types errors. So every optional field is a **string**
 * (the service coalesces `undefined → ''`), keeping columns stable TEXT. JSON
 * blobs (`address`, `metadata`) are serialized strings, merged by the service
 * before emit. Timestamps are epoch millis carried in `at` so folds stay
 * deterministic. Tenant = org id (this data is genuinely per-org partitioned).
 *
 * Fields added in 0.4.0 (`kind`, `roles`, `website`, `locked`) are absent from
 * older events; the read model holds NULL for them and the service reads that
 * as the default (a company, a customer, nothing locked).
 *
 *   kind     `company` or `person`
 *   roles    what the party is to the organization, as `,customer,supplier,`
 *            (delimited on both sides so one role can be matched with `like`)
 *   locked   JSON array of field names a person has locked against updates
 */
export const CUSTOMER_KINDS = ['company', 'person'] as const
export const CUSTOMER_ROLES = ['customer', 'supplier', 'employee', 'partner'] as const
/** The fields a person may lock. */
export const LOCKABLE_FIELDS = ['name', 'email', 'phone', 'website', 'taxId', 'currency', 'address'] as const

const snapshot = {
  externalId: z.string(), // the id in the user's own third-party system; '' if none
  name: z.string().min(1),
  email: z.string(),
  phone: z.string(),
  taxId: z.string(),
  currency: z.string(), // ISO-4217 or ''
  address: z.string(), // JSON object, serialized ('{}' if none)
  metadata: z.string(), // JSON object, serialized
  kind: z.enum(CUSTOMER_KINDS),
  roles: z.string(),
  website: z.string(),
  locked: z.string(), // JSON array, serialized
}

export const CustomerEvents = defineAggregate('customer', {
  CustomerCreated: z.object({ ...snapshot, shortId: z.string().min(1), at: z.number().int() }),
  CustomerUpdated: z.object({ ...snapshot, at: z.number().int() }),
  CustomerArchived: z.object({
    reason: z.string().optional(),
  }),
  // Archiving removes the row from the read model, so bringing one back
  // carries the whole record as it stood when it was archived.
  CustomerRestored: z.object({
    ...snapshot,
    shortId: z.string().min(1),
    createdAt: z.number().int(),
    at: z.number().int(),
  }),
})

/**
 * A person's place at a company: one link per pair, with what they are there.
 * Its own aggregate, so a link is added and removed without touching either
 * record's stream.
 */
export const LinkEvents = defineAggregate('customer_link', {
  LinkCreated: z.object({
    personId: z.string().min(1),
    companyId: z.string().min(1),
    title: z.string(), // '' if none
    at: z.number().int(),
  }),
  LinkRetitled: z.object({ title: z.string(), at: z.number().int() }),
  LinkRemoved: z.object({}),
})
