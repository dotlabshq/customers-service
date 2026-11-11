import type { MiddlewareHandler } from 'hono'
import { signHs256Jwt } from '@baseworks/auth/jwt'
import { can, type PermissionSet } from '@baseworks/core/permissions'
import { createOrgClient, permissionReader } from '@baseworks/org'

/**
 * What customers-service asks org-service, beyond "which organization is this".
 *
 * This service does not decide who may do what and names no role. It tells
 * org-service what its own actions ask for (`register()`, once at boot, as the
 * app `customers`), and for each request asks, **with the person's own token**,
 * which of those actions they may do in the organization. `can()` reads the
 * answer (workspace ADR 0003 §5a).
 *
 * Until the registration has succeeded org-service answers with no
 * permissions, so a person is refused everything. Closed, not open.
 *
 *   ORG_SERVICE_URL                  org-service's own address (not a gateway's)
 *   AUTH_URL                         auth-service's API, for this service's own token
 *   CUSTOMERS_SERVICE_CLIENT_ID      default `customers`: the name it registers as
 *   CUSTOMERS_SERVICE_CLIENT_SECRET  its secret at auth-service (AUTH_SERVICE_CLIENTS)
 *   CUSTOMERS_PERMISSION_CACHE_SECONDS  how long an answer is kept; default 15
 */

/** The app customers-service is, to org-service's decision point. */
export const CUSTOMERS_APP = 'customers'

/** What each action asks for. Registered at boot; org-service decides with it. */
export const CUSTOMERS_ACTIONS = {
  // Listing, searching and reading records.
  'customer.read': { min_role: 'viewer', access: 'read' },
  // Creating and changing them.
  'customer.write': { min_role: 'member', access: 'write' },
  // Archiving one. Its own action so a product can ask for more than `write`.
  'customer.archive': { min_role: 'member', access: 'write' },
} as const

export type CustomersAction = keyof typeof CUSTOMERS_ACTIONS

export interface OrgAccess {
  /** What this person may do with this service's actions in one organization. */
  permissions(bearer: string, orgId: string, userId: string): Promise<PermissionSet>
  /** Tell org-service what the actions ask for. Throws when it is refused. */
  register(): Promise<void>
}

type Env = Record<string, string | undefined>

export function orgAccess(baseUrl: string, env: Env = process.env, fetchImpl?: typeof fetch): OrgAccess {
  const ttl = Number(env['CUSTOMERS_PERMISSION_CACHE_SECONDS'] ?? 15)
  const remembered = permissionReader({ ttlSeconds: Number.isFinite(ttl) ? ttl : 15 })
  const client = (token: string) => createOrgClient({ baseUrl, token, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
  const doFetch = (...a: Parameters<typeof fetch>) => (fetchImpl ?? globalThis.fetch)(...a)

  /** This service's own identity, for the one call it makes as itself. */
  async function ownToken(): Promise<string | null> {
    const id = env['CUSTOMERS_SERVICE_CLIENT_ID'] ?? CUSTOMERS_APP
    const authUrl = (env['AUTH_URL'] ?? '').replace(/\/+$/, '')
    const secret = env['CUSTOMERS_SERVICE_CLIENT_SECRET']
    if (authUrl && secret) {
      const res = await doFetch(`${authUrl}/service-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: id, client_secret: secret, expires_in: 300 }),
      })
      const data = (await res.json().catch(() => ({}))) as { token?: string }
      return res.status === 200 && data.token ? data.token : null
    }
    // A realm still on the shared secret signs for itself, as every service
    // there does. It is the legacy path and proves nothing between services.
    const shared = env['JWT_SECRET']
    return shared ? signHs256Jwt({ sub: id, type: 'service' }, shared, 300) : null
  }

  return {
    permissions(bearer, orgId, userId) {
      return remembered.read(`${userId}\u0000${orgId}`, () =>
        client(bearer).permissions({ app: CUSTOMERS_APP, scopeId: orgId }))
    },
    async register() {
      const token = await ownToken()
      if (!token) throw new Error('customers-service has no service identity')
      await client(token).registerApp({
        name: CUSTOMERS_APP,
        origin: env['APP_PUBLIC_URL'] || 'customers-service',
        actions: CUSTOMERS_ACTIONS,
      } as never)
    },
  }
}

/**
 * The gate on one route: may this caller do `action` in the request's
 * organization? Runs after `requireAuth` and `requireOrg`.
 *
 * A service token is a plane caller acting as itself: `requireOrg` already let
 * it through without a membership, and there is no person to ask about. That
 * is unchanged here; which services may do what is not narrowed yet.
 */
export function permit(org: OrgAccess, action: CustomersAction): MiddlewareHandler {
  return async (c, next) => {
    if (c.get('orgRole') === 'service') return next()
    const auth = c.get('auth') as { userId: string }
    let set: PermissionSet
    try {
      set = await org.permissions(c.get('bearer'), c.get('orgId'), auth.userId)
    } catch (e) {
      // Cannot ask is not "yes".
      return c.json({ error: 'authz_unavailable', message: (e as Error).message }, 502)
    }
    if (!can(set, action)) {
      return c.json({ error: 'forbidden', message: `Missing permission ${action}`, permission: action }, 403)
    }
    return next()
  }
}

/**
 * Register the actions with org-service, retrying while it is not up yet (a
 * realm starts in no fixed order). Never throws and never blocks the boot.
 */
export async function registerWithOrg(access: OrgAccess, opts: { attempts?: number; delayMs?: number; log?: (m: string) => void } = {}): Promise<boolean> {
  const attempts = opts.attempts ?? 10
  const log = opts.log ?? ((m) => console.log(m))
  let last = ''
  for (let i = 1; i <= attempts; i++) {
    try {
      await access.register()
      log(`customers-service: registered its actions with org-service (${Object.keys(CUSTOMERS_ACTIONS).length})`)
      return true
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, opts.delayMs ?? 3_000))
  }
  log(`customers-service: NOT registered with org-service after ${attempts} attempts (${last}); people are refused until a later start succeeds`)
  return false
}
