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
  externalId: 'acct-42',      // your own id for this customer
  currency: 'USD',
  metadata: { tier: 'gold' },
})

await customers.list()                 // Customer[]
await customers.get(acme.id)           // by id, shortId, or externalId
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
