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
| `GET` | `/customers` | `customer.read` | list (`?limit&offset`, `?external_id=` for lookup) |
| `GET` | `/customers/:ref` | `customer.read` | by id / short_id |
| `POST` | `/customers` | `customer.write` | create |
| `PATCH` | `/customers/:ref` | `customer.write` | update |
| `DELETE` | `/customers/:ref` | `customer.archive` | archive |
| `GET` | `/.well-known/service` · `/openapi.yaml` | none | as every service |

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

Fields: `name` (required), `email`, `phone`, `taxId`, `currency`, `externalId`,
`address`, `metadata`. A consumer stores only `customer_id` and reads the profile
here (ADR-008 pattern).

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
