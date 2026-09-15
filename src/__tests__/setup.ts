import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { FoldBase } from '@baseworks/foldbase'
import { signHs256Jwt } from '@baseworks/auth/jwt'
// The foldbase conformance harness boots the Go binary as a private sibling.
// @ts-expect-error — plain ESM helper, no types
import { bootServer, signJwt } from '../../../foldbase/conformance/harness.mjs'
import { createApp, registerDefinitions } from '../app.js'

const here = dirname(fileURLToPath(import.meta.url))
const FB_SECRET = 'customers-service-foldbase-secret-32!'

export const JWT_SECRET = 'test-secret-32-chars-long-enough!'
export const USER_ID = 'user-test-001'

/**
 * A fresh organization per test.
 *
 * The org id IS the storage tenant here, so two tests sharing one would share a
 * directory — and the isolation this service is built on would be the thing not
 * under test. A unique foldbase tenant on the client does nothing: the store
 * overrides it per request with the org id.
 */
export const newOrgId = (): string => `org-${randomUUID()}`

process.env['JWT_SECRET'] = JWT_SECRET

export interface TestFoldBase {
  base: string
  svcToken: string
  stop: () => Promise<void>
}

/** One foldbase Go sibling per test file, on an in-memory SQLite. */
export async function bootTestFoldBase(): Promise<TestFoldBase> {
  const es = await bootServer({
    cmd: './bin/foldbase',
    dir: resolve(here, '../../../foldbase/go'),
    env: { FOLDBASE_AUTH: 'service-jwt', FOLDBASE_JWT_SECRET: FB_SECRET },
  })
  const svcToken = signJwt({ sub: 'customers-service', type: 'service' }, FB_SECRET)
  return { base: es.base, svcToken, stop: es.stop }
}

export function makeToken(userId = USER_ID): string {
  return signHs256Jwt({ sub: userId, type: 'human' }, JWT_SECRET, 3600)
}

export function makeServiceToken(name = 'svc'): string {
  return signHs256Jwt({ sub: name, type: 'service' }, JWT_SECRET, 3600)
}

/**
 * Stand in for org-service, the PDP.
 *
 * Every request here asks it whether the caller is a member, so a test that did
 * not answer that question would be testing nothing but a 502. `roles` maps an
 * org id to what the PDP says; anything absent answers `none`, which is how a
 * non-member looks.
 */
export function fakeOrgService(roles: Record<string, string>, aliases: Record<string, string> = {}) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes('/authz/role')) return realFetch(input as never, init)
    const named = new URL(url).searchParams.get('scope') ?? ''
    // The real PDP resolves an id, a slug or a short id and answers with the
    // scope it landed on. `aliases` is how a test says "this slug is that org".
    const scope = aliases[named] ?? named
    const role = roles[scope] ?? 'none'
    const body = role === 'none'
      ? { role: 'none' }
      : { role, via: { scopeId: scope, scopeKind: 'org' } }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return () => { globalThis.fetch = realFetch }
}

/**
 * An app on the shared foldbase, with `orgId` as the org every request names
 * unless it says otherwise.
 */
export async function makeTestApp(fb: TestFoldBase, orgId: string) {
  const client = new FoldBase({ baseUrl: fb.base, token: fb.svcToken, tenant: 'unused' })
  await registerDefinitions(client)
  const app = createApp(client, 'http://org.test')

  function req(method: string, path: string, body?: unknown, o: { token?: string; org?: string | null } = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${o.token ?? makeToken()}`,
      'Content-Type': 'application/json',
    }
    // `org: null` is how a test says "send no X-Org-Id at all".
    if (o.org !== null) headers['X-Org-Id'] = o.org ?? orgId
    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = JSON.stringify(body)
    return app.fetch(new Request(`http://localhost${path}`, init))
  }

  return {
    app,
    get: (path: string, o?: Parameters<typeof req>[3]) => req('GET', path, undefined, o),
    post: (path: string, body: unknown, o?: Parameters<typeof req>[3]) => req('POST', path, body, o),
    patch: (path: string, body: unknown, o?: Parameters<typeof req>[3]) => req('PATCH', path, body, o),
    del: (path: string, o?: Parameters<typeof req>[3]) => req('DELETE', path, undefined, o),
    unauth: (path: string) => app.fetch(new Request(`http://localhost${path}`, { method: 'GET' })),
  }
}
