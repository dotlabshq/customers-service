# customers-service

A per-org **customer directory** capability service in the baseworks plane
(ADR-010). Foldbase-backed, org-scoped (tenant = org id), org membership enforced
via org-service (the PDP).

- **Client / CLI**: [`@baseworks/customers`](./clients/ts) (published to npm).
- **Runtime**: Hono + `@baseworks/sdk` (`createEnv`) over one shared foldbase.

## REST surface

Routes live at the service root; a gateway publishes them at
`/v1/customers/...` and strips that prefix (ADR-042 §4). `/v1` is also mounted
here for callers that predate the gateway.

All routes require `Authorization: Bearer <identity-jwt>` + `X-Org-Id: <org>`.

| Method | Path | |
|---|---|---|
| `GET` | `/customers` | list (`?limit&offset`, `?external_id=` for lookup) |
| `GET` | `/customers/:ref` | by id / short_id |
| `POST` | `/customers` | create |
| `PATCH` | `/customers/:ref` | update |
| `DELETE` | `/customers/:ref` | archive |
| `GET` | `/healthz` · `/.well-known/service` · `/openapi.yaml` | as every service |

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
- `ORG_SERVICE_URL` — org-service, the PDP.
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
