import { Hono } from 'hono'
import type { FoldBase } from '@baseworks/foldbase'
import { PROJECTIONS, POLICIES } from '@baseworks/customers/projections'
import { customersRouter } from './routes/customers.js'
import { StoreError, createStore } from './store.js'

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
  app.route('/', customersRouter(store, orgBaseUrl))

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
