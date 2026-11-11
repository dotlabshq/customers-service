import { Hono, type Context } from 'hono'
import { readFileSync } from 'node:fs'
import type { FoldBase } from '@baseworks/foldbase'
import { serviceManifest } from '@baseworks/core/service'
import { PROJECTIONS, POLICIES } from '@baseworks/customers/projections'
import { customersRouter } from './routes/customers.js'
import { orgAccess, type OrgAccess } from './lib/org.js'
import { StoreError, createStore } from './store.js'

// Read once: the release is a build-time fact, and re-reading it per request
// would turn a manifest fetch into disk I/O.
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as
      { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Register read models + policies on boot (idempotent, like migrations). */
export async function registerDefinitions(fb: FoldBase): Promise<void> {
  for (const p of PROJECTIONS) await fb.putProjection(p.def)
  for (const p of POLICIES) await fb.putPolicy(p)
}

/** A store's refusal becomes its own status and code; anything else is a 500 that says nothing. */
const onError = (err: Error, c: Context) => {
  if (err instanceof StoreError) return c.json({ error: err.code, message: err.message }, err.status as never)
  const status = (err as { status?: number }).status
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return c.json({ error: (err as { code?: string }).code ?? 'error', message: err.message }, status as never)
  }
  console.error(err)
  return c.json({ error: 'internal', message: 'Internal server error' }, 500)
}

/**
 * Build the customers-service Hono app. `orgBaseUrl` is org-service's own
 * address: the app verifies org membership there before touching any customer,
 * and asks it what the caller may do (`opts.org`, built from the same address
 * unless a test hands one in).
 */
export function createApp(fb: FoldBase, orgBaseUrl: string, opts: { org?: OrgAccess } = {}): Hono {
  const store = createStore(fb)
  const org = opts.org ?? orgAccess(orgBaseUrl)
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true, service: 'customers-service' }))

  // The mounts (workspace ADR 0003):
  //
  //   /api   the API: what a gateway publishes at `/v1/customers`, replacing
  //          the prefix. Discovery and the contract are part of it.
  //   /      not published: `/healthz`.
  //
  // `/ui` (pages) and `/_` (internal routes) are the other two; this service
  // has neither yet, so neither is mounted.

  // What this service is and what contract it speaks. Unauthenticated: it
  // holds no secrets, and its readers include the gateway and signed-out clients.
  const manifest = (c: Context) =>
    c.json(
      serviceManifest({
        name: 'customers',
        version: VERSION,
        // Moves only when the HTTP surface breaks callers, not every release.
        api_version: '1.0',
        openapi_url: '/openapi.yaml',
        capabilities: ['customers', 'external-ids', 'org-scoped', 'permissions', 'kinds', 'roles', 'field-locks', 'restore', 'links'],
      }),
    )

  // The contract itself, served from the repo file so document and code ship
  // together and cannot drift apart between releases.
  const contract = (c: Context) => {
    try {
      const spec = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')
      return c.body(spec, 200, { 'content-type': 'application/yaml; charset=utf-8' })
    } catch {
      return c.json({ error: 'spec not bundled with this build' }, 404)
    }
  }

  const router = customersRouter(store, orgBaseUrl, org)

  const api = new Hono()
  api.get('/.well-known/service', manifest)
  api.get('/openapi.yaml', contract)
  api.route('/', router)
  api.onError(onError)
  app.route('/api', api)

  // ── Until every direct caller names `/api` ──────────────────────────────
  // The API used to be mounted at the root, and before that under `/v1`. Both
  // stay for now: services given this service's bare address, and a gateway
  // that still strips `/v1/customers` without adding `/api`, land here. The
  // same gates travel with the routes.
  app.get('/.well-known/service', manifest)
  app.get('/openapi.yaml', contract)
  app.route('/', router)
  app.route('/v1', router)

  app.onError(onError)

  return app
}
