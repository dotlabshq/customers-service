import { Command } from 'commander'
import { buildCustomersCommand } from '../cli.js'
import { createApiClient } from '@baseworks/cli/client'
import { runCommand, createMocks, server } from '@baseworks/cli/testing'

export { runCommand, server }

export const TEST_BASE = 'http://customers.test'
export const mocks = createMocks(TEST_BASE)

export function makeProgram(token = 'test-token') {
  const http = createApiClient(() => token, () => TEST_BASE)
  const program = new Command('dtab').exitOverride().enablePositionalOptions()
  program.addCommand(buildCustomersCommand({ http, cliName: 'dtab' }))
  return program
}

export function run(args: string[]) {
  return runCommand(makeProgram(), args)
}
