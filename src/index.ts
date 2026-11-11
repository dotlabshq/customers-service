import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { createEnv } from '@baseworks/sdk'
import { createApp, registerDefinitions } from './app.js'
import { orgAccess, registerWithOrg } from './lib/org.js'

const env = createEnv()

// Private foldbase sibling. Customers are per-org, so the store overrides the
// tenant per request (`withTenant(orgId)`); the base client is used only for the
// tenant-independent projection registration below.
const fb = env.service('foldbase')
await registerDefinitions(fb)

// org-service decides. Every request verifies membership there and asks what
// the caller may do. Its own address, not a gateway's: registration is internal.
const orgBaseUrl =
  process.env['ORG_SERVICE_URL'] ??
  process.env['ORG_URL'] ??
  (process.env['BASEWORKS_GATEWAY'] ? `${process.env['BASEWORKS_GATEWAY'].replace(/\/$/, '')}/org` : undefined)
if (!orgBaseUrl) throw new Error('ORG_SERVICE_URL not configured (needed for org membership checks)')

const root = new Hono()
root.use('*', logger())
// What a person may do here is org-service's to say. This service tells it
// what its actions ask for, in the background: it does not wait and does not
// fail without it, and until it succeeds people are refused.
const org = orgAccess(orgBaseUrl)
root.route('/', createApp(fb, orgBaseUrl, { org }))
void registerWithOrg(org)

const port = Number(env.var('PORT') ?? 3000)
serve({ fetch: root.fetch, port }, () => {
  console.log(`customers-service listening on :${port}  (org PDP: ${orgBaseUrl})`)
})
