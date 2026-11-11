# @baseworks/customers

Typed client, event catalog, projections, and CLI plugin for **customers-service** —
a per-org customer directory in the baseworks capability plane. Contract-first and
versioned with the service.

```bash
pnpm add @baseworks/customers
```

## Client

Customers are **org-scoped**: pass the active org id (sent as `X-Org-Id`) and the
caller's identity token. The service verifies org membership before every call.

```ts
import { createCustomersClient } from '@baseworks/customers'

const customers = createCustomersClient({
  baseUrl: process.env.CUSTOMERS_SERVICE_URL!, // e.g. https://api.example.com
  token:   identityJwt,                        // the signed-in user's JWT
  orgId:   activeOrgId,                         // resolved via org-service
})

const acme = await customers.create({
  name: 'Acme Co',
  email: 'billing@acme.test',
  external_id: 'acct-42',      // your own id for this customer
  currency: 'USD',
  metadata: { tier: 'gold' },
})

await customers.list()                 // Customer[]
await customers.get(acme.id)           // by id, short_id, or external_id
await customers.getByExternalId('acct-42')
await customers.update(acme.id, { phone: '+15551234' })
await customers.delete(acme.id)

// scope to a different org without a new client
customers.withOrg(otherOrgId)
```

Errors throw `CustomersError` with `.status` and `.code` (e.g. `409 external_id_taken`,
`404 not_found`).

## CLI plugin

Mount the branded `customers` command group into any [`commander`](https://github.com/tj/commander.js)
CLI. The `http` client must send the active org (`X-Org-Id`).

```ts
import { buildCustomersCommand } from '@baseworks/customers/cli'

program.addCommand(buildCustomersCommand({ http, cliName: 'dtab' }))
// → dtab customers | cust | customer  (list) · create · get · update · delete · ls
//   short_id columns, `-o wide` reveals the full id.
```

## Service integration (`/events`, `/projections`)

customers-service registers these on boot (idempotent). Consumers of the plane
don't need them; a service that embeds the customer domain does:

```ts
import { PROJECTIONS, POLICIES } from '@baseworks/customers/projections'
import { CustomerEvents } from '@baseworks/customers/events'
```

The projection is named `customers` → foldbase table `read_customers`. Tenant = org id.

## See also

- Service: `projects/customers-service` · plane overview:
  `docs/architecture/capability-services.md` · [ADR-010](../../../../docs/decisions/010-driptab-erp-decomposition.md).

## 0.3.0

For customers-service 0.4.0. A record has a `kind` (`company` or `person`),
a set of `roles`, a `website` and `locked_fields`; `list()` filters by `kind`,
`role` and `tax_id`.

```ts
await customers.update(id, { name: 'Acme GmbH', lock: ['name'] })   // set and lock
const { customer, skipped_fields } = await customers.updateWithResult(id, { name: 'ACME', email: 'a@acme.test' })
// skipped_fields: ['name'], the email is applied

await customers.delete(id)          // archive
await customers.restore(id)         // and back, whole

const link = await customers.link(companyId, personId, 'CFO')
await customers.links(personId)     // either side lists it
await customers.unlink(companyId, link.id)
```

`external_id` is the id in the user's own third-party system: one per record.
The event catalog gains `CustomerRestored` and the `customer_link` aggregate
(`LinkEvents`); the read model gains the `customer_links` projection.

## 0.4.0

For customers-service 0.5.0.

```ts
const { customers: firstPage, next_cursor } = await customers.page({ q: 'acme', kind: 'company', limit: 50 })
for await (const c of customers.all({ role: 'supplier' })) { /* every supplier, page by page */ }

const some = await customers.getMany([idA, idB])          // one request, at most 100

// Keeping something in step with the directory:
let cursor = saved                                         // undefined the first time
const feed = await customers.changes({ after: cursor })
const fresh = await customers.getMany([...new Set(feed.changes.map((c) => c.id))])
cursor = feed.cursor                                       // an archived record is simply not in `fresh`
```

`list()` still answers a plain array.

## 0.5.0 — the wire is snake_case

For customers-service 0.6.0, which speaks snake_case like the rest of the realm
(ADR-043). **Breaking for code that reads fields**: `shortId` → `short_id`,
`externalId` → `external_id`, `taxId` → `tax_id`, `createdAt` → `created_at`,
`updatedAt` → `updated_at`, `lockedFields` → `locked_fields`, `skippedFields` →
`skipped_fields`, `nextCursor` → `next_cursor`, `address.postalCode` →
`address.postal_code`; the lockable field is `tax_id`. `id`, `name`, `email`,
`phone`, `currency`, `kind`, `roles`, `website` and `metadata` are unchanged.
This client needs service 0.6.0 or later; the service still reads the old
names in a request, so an older client keeps writing but reads undefined for
the renamed fields. The GraphQL module keeps its camelCase field names.
