# customers-service

A per-org **customer directory** capability service in the baseworks plane
(ADR-010). Foldbase-backed, org-scoped (tenant = org id), org membership enforced
via org-service (the PDP).

- **Client / CLI**: [`@baseworks/customers`](./clients/ts) (published to npm).
- **Runtime**: Hono + `@baseworks/sdk` (`createEnv`) over one shared foldbase.

## REST surface (`/v1/customers`)

All routes require `Authorization: Bearer <identity-jwt>` + `X-Org-Id: <org>`.

| Method | Path | |
|---|---|---|
| `GET` | `/v1/customers` | list (`?limit&offset`, `?external_id=` for lookup) |
| `GET` | `/v1/customers/:ref` | by id / short_id / external_id |
| `POST` | `/v1/customers` | create |
| `PATCH` | `/v1/customers/:ref` | update |
| `DELETE` | `/v1/customers/:ref` | archive |

Fields: `name` (required), `email`, `phone`, `taxId`, `currency`, `externalId`,
`address`, `metadata`. A consumer stores only `customer_id` and reads the profile
here (ADR-008 pattern).

## Env

- `FOLDBASE_SERVICE_URL` — the shared foldbase.
- `ORG_SERVICE_URL` — org-service, for membership checks.
- `JWT_SECRET` — shared realm secret (verifies the identity JWT).
- `PORT` (default 3000).

## Run

Locally it runs inside the plane — see [`infra/local`](../../infra/local) (compose +
Caddy). Build/publish the image with the justfile:

```bash
just build-docker 0.1.0   # → ghcr.io/dotlabshq/customers-service:0.1.0
just release-docker 0.1.0 # build + push
```
