import type {
  Customer, CreateCustomerInput, UpdateCustomerInput, UpdateResult, ListCustomersOptions, CustomerLink,
} from './types.js'

export type {
  Customer,
  CustomerRow,
  Address,
  CreateCustomerInput,
  UpdateCustomerInput,
  UpdateResult,
  ListCustomersOptions,
  CustomerKind,
  CustomerRole,
  LockableField,
  CustomerLink,
  LinkParty,
  LinkRow,
} from './types.js'

export interface CustomersClientOptions {
  /** Base URL of customers-service (resolved by the SDK, e.g. CUSTOMERS_SERVICE_URL). */
  baseUrl: string
  /** Bearer token — the caller's identity JWT. */
  token?: string
  /** Active org id — sent as X-Org-Id (customers are org-scoped, tenant = org). */
  orgId?: string
  /** Injectable fetch (tests / non-global environments). */
  fetch?: typeof fetch
}

/** Thrown on any non-2xx response from customers-service. */
export class CustomersError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'CustomersError'
  }
}

/** Minimal ApiClient shape — structurally compatible with @baseworks/cli. */
export interface HttpClient {
  api<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>
  get<T>(path: string, headers?: Record<string, string>): Promise<T>
  post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>
  patch<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>
  del<T>(path: string, headers?: Record<string, string>): Promise<T>
}

/**
 * Typed HTTP client for customers-service. Thin wrapper over the REST surface;
 * the service validates. Every call carries the org id (X-Org-Id) — customers
 * are per-org, and the identity JWT is org-less by design (ADR-009).
 */
/**
 * Paths here are the service's own — `/customers`, not `/v1/customers`.
 *
 * A service mounts its routes at its root and a gateway publishes it at
 * `/v1/<name>`, stripping that prefix before the request arrives (ADR-042 §4),
 * so a service never encodes where it happens to be mounted and neither does
 * its client. `baseUrl` is wherever the service answers.
 */
export class CustomersClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  constructor(private readonly opts: CustomersClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.fetchImpl = opts.fetch ?? globalThis.fetch
  }

  /** Return a new client scoped to a different org. */
  withOrg(orgId: string): CustomersClient {
    return new CustomersClient({ ...this.opts, orgId })
  }

  private headers(json: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (this.opts.token) h['Authorization'] = `Bearer ${this.opts.token}`
    if (this.opts.orgId) h['X-Org-Id'] = this.opts.orgId
    return { ...h, ...extra }
  }

  async api<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined, extra),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status === 204) return null as T
    const text = await res.text()
    const data = text ? (JSON.parse(text) as unknown) : undefined
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string | { code?: string; message?: string }; message?: string }
      const code = typeof e.error === 'string' ? e.error : e.error?.code ?? 'error'
      const msg = typeof e.error === 'object' ? e.error?.message : e.message
      throw new CustomersError(res.status, code, msg)
    }
    return data as T
  }

  /** Generic ApiClient (get/post/patch/del) — used by the CLI plugin. */
  get http(): HttpClient {
    return {
      api: this.api.bind(this),
      get: <T>(p: string, h?: Record<string, string>) => this.api<T>('GET', p, undefined, h),
      post: <T>(p: string, b: unknown, h?: Record<string, string>) => this.api<T>('POST', p, b, h),
      patch: <T>(p: string, b: unknown, h?: Record<string, string>) => this.api<T>('PATCH', p, b, h),
      del: <T>(p: string, h?: Record<string, string>) => this.api<T>('DELETE', p, undefined, h),
    }
  }

  // ── customers ─────────────────────────────────────────────────────────────

  async list(opts: ListCustomersOptions = {}): Promise<Customer[]> {
    const q = new URLSearchParams()
    if (opts.limit !== undefined) q.set('limit', String(opts.limit))
    if (opts.offset !== undefined) q.set('offset', String(opts.offset))
    if (opts.kind) q.set('kind', opts.kind)
    if (opts.role) q.set('role', opts.role)
    if (opts.taxId) q.set('tax_id', opts.taxId)
    const qs = q.toString()
    const { customers } = await this.api<{ customers: Customer[] }>('GET', `/customers${qs ? `?${qs}` : ''}`)
    return customers
  }
  async get(ref: string): Promise<Customer> {
    const { customer } = await this.api<{ customer: Customer }>('GET', `/customers/${ref}`)
    return customer
  }
  async getByExternalId(externalId: string): Promise<Customer> {
    const { customer } = await this.api<{ customer: Customer }>('GET', `/customers?external_id=${encodeURIComponent(externalId)}`)
    return customer
  }
  async create(input: CreateCustomerInput): Promise<Customer> {
    const { customer } = await this.api<{ customer: Customer }>('POST', '/customers', input)
    return customer
  }
  async update(ref: string, input: UpdateCustomerInput): Promise<Customer> {
    return (await this.updateWithResult(ref, input)).customer
  }
  /** As `update`, and also says which locked fields the write left alone. */
  async updateWithResult(ref: string, input: UpdateCustomerInput): Promise<UpdateResult> {
    const r = await this.api<{ customer: Customer; skippedFields?: UpdateResult['skippedFields'] }>('PATCH', `/customers/${ref}`, input)
    return { customer: r.customer, skippedFields: r.skippedFields ?? [] }
  }
  /** Archive. The record leaves every list; `restore` brings it back. */
  async delete(ref: string): Promise<void> {
    await this.api('DELETE', `/customers/${ref}`)
  }
  /** Bring an archived record back. By id only: an archived record has no other handle. */
  async restore(id: string): Promise<Customer> {
    const { customer } = await this.api<{ customer: Customer }>('POST', `/customers/${id}/restore`, {})
    return customer
  }

  // ── links: which person is at which company ───────────────────────────────

  async links(ref: string): Promise<CustomerLink[]> {
    const { links } = await this.api<{ links: CustomerLink[] }>('GET', `/customers/${ref}/links`)
    return links
  }
  /** Link `ref` to `to`. One of the two must be a person and the other a company. */
  async link(ref: string, to: string, title?: string): Promise<CustomerLink> {
    const { link } = await this.api<{ link: CustomerLink }>('POST', `/customers/${ref}/links`, { to, ...(title ? { title } : {}) })
    return link
  }
  async retitleLink(ref: string, linkId: string, title: string): Promise<CustomerLink> {
    const { link } = await this.api<{ link: CustomerLink }>('PATCH', `/customers/${ref}/links/${linkId}`, { title })
    return link
  }
  async unlink(ref: string, linkId: string): Promise<void> {
    await this.api('DELETE', `/customers/${ref}/links/${linkId}`)
  }
}

/** Factory used by the SDK capability registry. */
export function createCustomersClient(opts: CustomersClientOptions): CustomersClient {
  return new CustomersClient(opts)
}
