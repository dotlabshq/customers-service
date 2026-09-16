/// <reference types="vitest/globals" />
import { beforeAll, afterEach, afterAll, describe, it, expect } from 'vitest'
import { run, mocks, server } from './helpers.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const CUST = {
  id: '019f6a3e-1111-7c71-beff-496d1be3fd1f',
  shortId: 'cst9x2',
  externalId: 'acct-42',
  name: 'Acme Co',
  email: 'billing@acme.test',
  phone: null,
  taxId: null,
  currency: 'USD',
  address: null,
  metadata: { tier: 'gold' },
  createdAt: 1784200000000,
  updatedAt: 1784200000000,
}
const CUST2 = { ...CUST, id: '019f6a3e-2222-7c71-beff-496d1be3fd1f', shortId: 'cst7k1', externalId: 'acct-43', name: 'Beta Inc', email: null, currency: null }

describe('dtab customers (list)', () => {
  it('default columns: ID → NAME → EMAIL, no full UUID', async () => {
    mocks.mockGet('/customers', { customers: [CUST, CUST2] })
    const r = await run(['customers'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('cst9x2')
    expect(r.stdout).toContain('Acme Co')
    expect(r.stdout).toContain('billing@acme.test')
    expect(r.stdout.indexOf('ID')).toBeLessThan(r.stdout.indexOf('NAME'))
    expect(r.stdout).not.toContain(CUST.id)
  })

  it('customer (singular alias) lists', async () => {
    mocks.mockGet('/customers', { customers: [CUST] })
    const r = await run(['customer'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('cst9x2')
  })

  it('customers ls lists', async () => {
    mocks.mockGet('/customers', { customers: [CUST] })
    const r = await run(['customers', 'ls'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('cst9x2')
  })

  it('-o wide adds EXTERNAL, CUR, CREATED, FULL ID', async () => {
    mocks.mockGet('/customers', { customers: [CUST] })
    const r = await run(['customers', '-o', 'wide'])
    expect(r.stdout).toContain('EXTERNAL')
    expect(r.stdout).toContain('acct-42')
    expect(r.stdout).toContain('FULL ID')
    expect(r.stdout).toContain(CUST.id)
  })

  it('customers ls -o wide also shows FULL ID', async () => {
    mocks.mockGet('/customers', { customers: [CUST] })
    const r = await run(['customers', 'ls', '-o', 'wide'])
    expect(r.stdout).toContain('FULL ID')
    expect(r.stdout).toContain(CUST.id)
  })

  it('-o json returns raw array', async () => {
    mocks.mockGet('/customers', { customers: [CUST] })
    const r = await run(['customers', '-o', 'json'])
    const parsed = JSON.parse(r.stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].shortId).toBe('cst9x2')
  })
})

describe('dtab customers create', () => {
  it('sends name + optional fields + metadata', async () => {
    const captured = mocks.mockPostCapture('/customers', { customer: CUST })
    const r = await run(['customers', 'create', '--name', 'Acme Co', '--email', 'billing@acme.test', '--external-id', 'acct-42', '--currency', 'USD', '--meta', 'tier=gold'])
    expect(r.exitCode).toBe(0)
    const body = captured.body as Record<string, unknown>
    expect(body.name).toBe('Acme Co')
    expect(body.email).toBe('billing@acme.test')
    expect(body.externalId).toBe('acct-42')
    expect(body.currency).toBe('USD')
    expect(body.metadata).toEqual({ tier: 'gold' })
    expect(r.stdout).toContain('cst9x2')
    expect(r.stdout).not.toContain(CUST.id)
  })
})

describe('dtab customers get', () => {
  it('shows details incl. shortId, hides full UUID from id line', async () => {
    mocks.mockGet('/customers/acct-42', { customer: CUST })
    const r = await run(['customers', 'get', 'acct-42'])
    expect(r.exitCode).toBe(0)
    const idLine = r.stdout.split('\n').find((l) => /^\s+id\s/.test(l))
    expect(idLine).toContain('cst9x2')
    expect(idLine).not.toContain(CUST.id)
    expect(r.stdout).toContain('gold')
  })
})

describe('dtab customers update / delete', () => {
  it('update sends only changed fields', async () => {
    const captured = mocks.mockPatchCapture('/customers/cst9x2', { customer: { ...CUST, name: 'Acme HQ' } })
    const r = await run(['customers', 'update', 'cst9x2', '--name', 'Acme HQ'])
    expect(r.exitCode).toBe(0)
    expect((captured.body as Record<string, unknown>).name).toBe('Acme HQ')
  })

  it('delete works (and rm alias)', async () => {
    mocks.mockDelete('/customers/cst9x2')
    const r = await run(['customers', 'delete', 'cst9x2'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('cst9x2')
  })
})
