# customers-service

A per-org **customer directory** capability service in the baseworks plane
(ADR-010). Foldbase-backed, org-scoped (tenant = org id), org membership enforced
via org-service (the PDP).

- **Client / CLI**: [`@baseworks/customers`](./clients/ts) (published to npm).
- **Runtime**: Hono + `@baseworks/sdk` (`createEnv`) over one shared foldbase.

## Surfaces

The mounts follow workspace ADR 0003:

| Mount | What | Published |
|---|---|---|
| `/api` | the API | at `/v1/customers`; the gateway replaces the prefix |
| `/healthz` | liveness | never; internal network only |

`/ui` (pages) and `/_` (internal routes) are the other two mounts; this service
has neither yet. The API is also still mounted at the root and under `/v1`, for
direct callers that have not moved to `/api`; those mounts will be removed.

All routes require `Authorization: Bearer <identity-jwt>` + `X-Org-Id: <org>`.

| Method | Path (under `/api`) | Permission | |
|---|---|---|---|
| `GET` | `/customers` | `customer.read` | list, search, several by id; see below |
| `GET` | `/customers/:ref` | `customer.read` | by id / short_id |
| `POST` | `/customers` | `customer.write` | create |
| `PATCH` | `/customers/:ref` | `customer.write` | update |
| `DELETE` | `/customers/:ref` | `customer.archive` | archive |
| `POST` | `/customers/:id/restore` | `customer.archive` | bring an archived record back |
| `GET` | `/customers/:ref/links` | `customer.read` | who is at this company, or where this person is |
| `POST` | `/customers/:ref/links` | `customer.write` | link to another record: `{ to, title? }` |
| `PATCH` · `DELETE` | `/customers/:ref/links/:linkId` | `customer.write` | change the title, remove the link |
| `GET` | `/changes` | `customer.read` | what changed, for a service keeping in step |
| `GET` | `/.well-known/service` · `/openapi.yaml` | none | as every service |


`GET /customers` takes:

- `?kind=company|person`, `?role=<role>`, `?tax_id=` — filters, combinable.
- `?q=` — text in name, email, website, tax id or external id.
- `?limit=` (50, at most 500) and `?cursor=` — the answer carries `next_cursor`
  (null on the last page); pass it back to continue. A walk by cursor neither
  skips nor repeats a record when others are added meanwhile. `?offset=` still
  works and is ignored when a cursor is given.
- `?ids=a,b,c` — those records in one request (at most 100); ids that name
  nothing are left out.
- `?external_id=` — the one record, or 404.

**The change feed.** `GET /changes?after=<cursor>&limit=` answers
`{ changes: [{ seq, type, id, actor, at }], cursor }`, oldest first: the
record events of this organization (`CustomerCreated`, `CustomerUpdated`,
`CustomerArchived`, `CustomerRestored`). It says *that* a record changed, not
what it is now: read those with `?ids=`. Keep `cursor` and pass it as `after`
next time; with nothing new it comes back unchanged. Start with no `after` for
everything. `?entity=link` reads the links' feed instead (`LinkCreated`,
`LinkRetitled`, `LinkRemoved`).

## The record

The wire is snake_case, as everywhere in the realm (ADR-043). Before 0.6.0
this service spoke camelCase; a request that still names `externalId`, `taxId`
or `postalCode` is read as it meant, for now. Answers are snake_case only.

The directory is generic: the same record serves billing, accounting and a
CRM, so it says who a party is and nothing about what a product does with it.

| Field | |
|---|---|
| `name` | required |
| `kind` | `company` (default) or `person` |
| `roles` | a set of `customer`, `supplier`, `employee`, `partner`; default `[customer]`. Replaced whole on update |
| `email`, `phone`, `website`, `tax_id`, `currency`, `address` | optional |
| `external_id` | the id in the user's own third-party system. One per record, unique in the org. Anything more goes in `metadata` |
| `metadata` | free JSON, merged on update; the product's own |
| `locked_fields` | read only; see below |

A consumer stores only the record's `id` and reads the profile here; it does
not write its own ids into the record.

**Locked fields.** A person can lock `name`, `email`, `phone`, `website`,
`tax_id`, `currency` or `address`: `PATCH { "lock": ["name"] }`. A later write
that names a locked field leaves it as it is, applies the rest, and answers
with `skipped_fields`. `unlock` is applied before the write and `lock` after it,
so "unlock and change" and "set and lock" are each one request. Only a person
locks or unlocks; a service token is answered `403 person_only`.

**Archive and restore.** Archiving removes the record from every read; its
events stay. `POST /customers/:id/restore` writes it back whole, under the
same id and short id, with its locks. By id only, and refused (`409`) while
another record holds its `external_id`.

**Links.** A link joins one person and one company, with an optional `title`
(what the person is there). Each pair once; a person can be at several
companies. Either side lists it. A link to an archived record is not shown
and returns with the record.

Records written before 0.4.0 carry none of the new fields and read as a
company that is a customer, with nothing locked.

## Permissions

The code names a permission, never a role. At boot the service registers its
actions with org-service as the app `customers` (`src/lib/org.ts`):

| Action | Asks for |
|---|---|
| `customer.read` | viewer, read access |
| `customer.write` | member, write access |
| `customer.archive` | member, write access |

For each request it asks org-service, with the caller's own token, which of
these the person may do in the organization, keeps the answer for a few seconds
and tests it with `can()`. A missing permission is `403` with the permission
named; org-service not answering is `502`. **Until the registration succeeds a
person is refused everything**, so in a realm on ES256 the service needs its
own client at auth-service (see Env). A **service token** acts as itself and is
not asked about; which services may do what is not narrowed yet.

## The org is resolved, not taken at its word

`X-Org-Id` may name an organization by id, slug or short id (ADR-042 §3) — a
console sends the id it has, a CLI that ran `use acme` sends the slug. The org
id is also the storage tenant, so using the header verbatim would give one
organization two directories, depending on which client wrote last.

The PDP answers with the scope it resolved, and that canonical id is what this
service stores against. A **service token** skips the membership check, and
therefore skips that resolution: a service must name the org by its id.

## Env

- `FOLDBASE_URL` (or `FOLDBASE_SERVICE_URL`) — the shared foldbase.
- `ORG_SERVICE_URL` — org-service's own address (not a gateway's): membership,
  permissions, and the registration at `/_/apps/register`.
- `AUTH_URL`, `CUSTOMERS_SERVICE_CLIENT_SECRET` (and `CUSTOMERS_SERVICE_CLIENT_ID`,
  default `customers`) — the service's own identity for that registration, from
  auth-service's `AUTH_SERVICE_CLIENTS`. Without them it signs with `JWT_SECRET`,
  which only a realm still on the shared secret accepts.
- `CUSTOMERS_PERMISSION_CACHE_SECONDS` — how long an answer is kept; default 15.
- `JWT_SECRET` — legacy HS256 realm secret, accepted while set. A realm on
  ES256 sets `AUTH_JWKS_URI` (plus `AUTH_ISSUER` / `AUTH_AUDIENCE`) instead.
- `PORT` (3008 in the dev realm).

See `.env.example`.

## Run

In the workspace realm, behind the dev gateway on `:8080`:

```bash
pnpm dev:customers   # this service on :3008
pnpm proxy           # the gateway publishes it at /v1/customers
bw customers         # and the CLI reaches it there
```

`pnpm test` boots a real foldbase on an in-memory SQLite and stands in for
org-service, so the membership gate is exercised rather than stubbed away.

Build/publish the image with the justfile:

```bash
just build-docker 0.1.0   # → ghcr.io/dotlabshq/customers-service:0.1.0
just release-docker 0.1.0 # build + push
```
