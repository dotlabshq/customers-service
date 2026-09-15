import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import type { FoldBase } from '@baseworks/foldbase'
import { serviceManifest } from '@baseworks/core/service'
import { PROJECTIONS, POLICIES } from '@baseworks/customers/projections'
import { customersRouter } from './routes/customers.js'
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

/**
 * Build the customers-service Hono app. `orgBaseUrl` is org-service's URL — the
 * app verifies org membership there before touching any customer (the PDP is
 * org-owned; customers is an org-scoped capability).
 */
export function createApp(fb: FoldBase, orgBaseUrl: string): Hono {
  const store = createStore(fb)
  const app = new Hono()

  app.get('/healthz', (c) => c.json({ ok: true, service: 'customers-service' }))

  // What this service is and what contract it speaks (ADR-042 §8). There is no
  // registry: a client asks each known base for this, and whatever does not
  // answer is not installed. Unauthenticated — it holds no secrets, and its
  // readers include the gateway and signed-out clients.
  app.get('/.well-known/service', (c) =>
    c.json(
      serviceManifest({
        name: 'customers',
        version: VERSION,
        // Moves only when the HTTP surface breaks callers, not every release.
        api_version: '1.0',
        openapi_url: '/openapi.yaml',
        capabilities: ['customers', 'external-ids', 'org-scoped'],
      }),
    ),
  )

  // The contract itself, served from the repo file so document and code ship
  // together and cannot drift apart between releases.
  app.get('/openapi.yaml', (c) => {
    try {
      const spec = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')
      return c.body(spec, 200, { 'content-type': 'application/yaml; charset=utf-8' })
    } catch {
      return c.json({ error: 'spec not bundled with this build' }, 404)
    }
  })

  const router = customersRouter(store, orgBaseUrl)
  app.route('/', router)
  // Legacy mount, for callers that predate the gateway — including the
  // published @baseworks/customers client and anything pointed straight at the
  // service. Remove once every consumer is on the gateway path.
  app.route('/v1', router)

  app.onError((err, c) => {
    if (err instanceof StoreError) return c.json({ error: err.code, message: err.message }, err.status as never)
    const status = (err as { status?: number }).status
    if (typeof status === 'number' && status >= 400 && status < 600) {
      return c.json({ error: (err as { code?: string }).code ?? 'error', message: err.message }, status as never)
    }
    console.error(err)
    return c.json({ error: 'internal', message: 'Internal server error' }, 500)
  })

  return app
}
