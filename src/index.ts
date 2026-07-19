import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { createEnv } from '@baseworks/sdk'
import { createApp, registerDefinitions } from './app.js'

const env = createEnv()

// Private foldbase sibling. Customers are per-org, so the store overrides the
// tenant per request (`withTenant(orgId)`); the base client is used only for the
// tenant-independent projection registration below.
const fb = env.service('foldbase')
await registerDefinitions(fb)

// org-service — the PDP. Every customer op verifies membership there.
const orgBaseUrl =
  process.env['ORG_SERVICE_URL'] ??
  process.env['ORG_URL'] ??
  (process.env['BASEWORKS_GATEWAY'] ? `${process.env['BASEWORKS_GATEWAY'].replace(/\/$/, '')}/org` : undefined)
if (!orgBaseUrl) throw new Error('ORG_SERVICE_URL not configured (needed for org membership checks)')

const root = new Hono()
root.use('*', logger())
root.route('/', createApp(fb, orgBaseUrl))

const port = Number(env.var('PORT') ?? 3000)
serve({ fetch: root.fetch, port }, () => {
  console.log(`customers-service listening on :${port}  (org PDP: ${orgBaseUrl})`)
})
