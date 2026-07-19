import { Command } from 'commander'
import { clr, kv, table, summary, success, warn, fatal, printOutput, outputOption } from '@baseworks/cli/display'
import { fmtDate } from '@baseworks/cli/fmt'
import type { ColDef } from '@baseworks/cli/display'
import type { ApiClient } from '@baseworks/cli/client'

/**
 * Importable `customers` command group for any CLI. The `http` ApiClient points
 * at the app's customers mount and carries the caller's identity token; it must
 * also send the active org (X-Org-Id) — customers are org-scoped. Mounts as:
 *
 *   program.addCommand(buildCustomersCommand({ http, cliName: 'dtab' }))
 *
 * Usage: `dtab customers` (list) · `customers ls` · `customers create` ·
 *        `customers get <ref>` · `customers update <ref>` · `customers delete <ref>`
 */
export interface CustomersCliDeps {
  http: ApiClient
  cliName?: string
}

type CustomerRow = {
  id: string
  shortId: string
  externalId: string | null
  name: string
  email: string | null
  currency: string | null
  createdAt?: number
}

const die = (e: unknown): never => fatal(e instanceof Error ? e.message : String(e))

function parseKvPairs(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs ?? []) {
    const i = p.indexOf('=')
    if (i < 0) fatal(`--meta expects key=value, got '${p}'`)
    out[p.slice(0, i)] = p.slice(i + 1)
  }
  return out
}

export function buildCustomersCommand(deps: CustomersCliDeps): Command {
  const { http } = deps
  const cli = deps.cliName ?? 'cli'

  const listCustomers = async (opts: { output: string }) => {
    const res = await http.get<{ customers: CustomerRow[] }>('/v1/customers').catch(die)
    printOutput(res.customers, opts.output, (wide) => {
      table(res.customers, [
        { key: 'shortId', label: 'ID' },
        { key: 'name', label: 'NAME' },
        { key: 'email', label: 'EMAIL', fmt: (v) => (v as string) ?? '' },
        { key: 'externalId', label: 'EXTERNAL', wide: true, fmt: (v) => (v as string) ?? '' },
        { key: 'currency', label: 'CUR', wide: true, fmt: (v) => (v as string) ?? '' },
        { key: 'createdAt', label: 'CREATED', wide: true, fmt: (v) => fmtDate(v as number) },
        { key: 'id', label: 'FULL ID', wide: true },
      ] as ColDef<CustomerRow>[], { wide, emptyHint: `No customers yet.  Run: ${cli} customers create --name <n>` })
      summary(`${res.customers.length} customer${res.customers.length !== 1 ? 's' : ''}`)
    }, 'id')
  }

  // `customers` (bare) → list. `customers ls` is the same.
  const cmd = new Command('customers')
    .aliases(['customer', 'cust'])
    .description('Manage customers (org-scoped — run `use <org>` first)')
    .option(...outputOption())
    .action(listCustomers)

  cmd.addCommand(
    new Command('ls')
      .description('List customers (alias of the bare command)')
      .option(...outputOption())
      .action(function (this: Command) {
        const self = this.opts() as { output?: string }
        const parent = (this.parent?.opts() ?? {}) as { output?: string }
        return listCustomers({ output: self.output && self.output !== 'table' ? self.output : parent.output ?? 'table' })
      }),
  )

  cmd.addCommand(
    new Command('create')
      .description('Create a customer')
      .requiredOption('--name <name>', 'Display name')
      .option('--email <email>', 'Email')
      .option('--phone <phone>', 'Phone')
      .option('--external-id <id>', "Caller-side id (your system's customer id)")
      .option('--tax-id <id>', 'Tax id')
      .option('--currency <cur>', 'ISO-4217 currency (e.g. USD)')
      .option('--meta <k=v...>', 'Metadata key=value (repeatable)')
      .action(async (opts: { name: string; email?: string; phone?: string; externalId?: string; taxId?: string; currency?: string; meta?: string[] }) => {
        const body = {
          name: opts.name,
          ...(opts.email ? { email: opts.email } : {}),
          ...(opts.phone ? { phone: opts.phone } : {}),
          ...(opts.externalId ? { externalId: opts.externalId } : {}),
          ...(opts.taxId ? { taxId: opts.taxId } : {}),
          ...(opts.currency ? { currency: opts.currency } : {}),
          ...(opts.meta ? { metadata: parseKvPairs(opts.meta) } : {}),
        }
        const res = await http.post<{ customer: CustomerRow }>('/v1/customers', body).catch(die)
        success(`Customer created: ${res.customer.name}`)
        kv([['id', res.customer.shortId], ['name', res.customer.name]])
      }),
  )

  cmd.addCommand(
    new Command('get').argument('<ref>', 'id, short_id, or external_id')
      .description('Show customer details')
      .option(...outputOption())
      .action(async (ref: string, opts: { output: string }) => {
        const res = await http.get<{ customer: Record<string, unknown> }>(`/v1/customers/${ref}`).catch(die)
        const cst = res.customer as Record<string, unknown>
        printOutput(cst, opts.output, () => {
          kv([
            ['id', String(cst['shortId'])],
            ['name', String(cst['name'])],
            ['email', (cst['email'] as string) ?? '—'],
            ['phone', (cst['phone'] as string) ?? '—'],
            ['external_id', (cst['externalId'] as string) ?? '—'],
            ['tax_id', (cst['taxId'] as string) ?? '—'],
            ['currency', (cst['currency'] as string) ?? '—'],
            ['full_id', String(cst['id'])],
          ])
          const meta = (cst['metadata'] as Record<string, unknown>) ?? {}
          if (Object.keys(meta).length) {
            console.log(`  ${clr.dim}── metadata ──${clr.reset}`)
            kv(Object.entries(meta).map(([k, v]) => [k, JSON.stringify(v)] as [string, string]))
          }
        }, 'id')
      }),
  )

  cmd.addCommand(
    new Command('update').argument('<ref>')
      .description('Update a customer')
      .option('--name <name>', 'New name')
      .option('--email <email>', 'Email')
      .option('--phone <phone>', 'Phone')
      .option('--external-id <id>', 'Caller-side id')
      .option('--tax-id <id>', 'Tax id')
      .option('--currency <cur>', 'ISO-4217 currency')
      .option('--meta <k=v...>', 'Metadata key=value (repeatable)')
      .action(async (ref: string, opts: { name?: string; email?: string; phone?: string; externalId?: string; taxId?: string; currency?: string; meta?: string[] }) => {
        const body: Record<string, unknown> = {}
        if (opts.name !== undefined) body['name'] = opts.name
        if (opts.email !== undefined) body['email'] = opts.email
        if (opts.phone !== undefined) body['phone'] = opts.phone
        if (opts.externalId !== undefined) body['externalId'] = opts.externalId
        if (opts.taxId !== undefined) body['taxId'] = opts.taxId
        if (opts.currency !== undefined) body['currency'] = opts.currency
        if (opts.meta !== undefined) body['metadata'] = parseKvPairs(opts.meta)
        if (!Object.keys(body).length) { warn('Provide at least one field to update.'); return }
        const res = await http.patch<{ customer: CustomerRow }>(`/v1/customers/${ref}`, body).catch(die)
        success('Customer updated.')
        kv([['id', res.customer.shortId], ['name', res.customer.name]])
      }),
  )

  cmd.addCommand(
    new Command('delete').alias('rm').argument('<ref>')
      .description('Delete a customer')
      .action(async (ref: string) => {
        await http.del(`/v1/customers/${ref}`).catch(die)
        success(`Customer deleted: ${ref}`)
      }),
  )

  return cmd
}
