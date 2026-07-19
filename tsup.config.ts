import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  dts: false,
  // Bundle the workspace @baseworks/* packages + framework so the runtime image
  // only needs the native externals (matches org-service).
  noExternal: [
    '@baseworks/auth',
    '@baseworks/core',
    '@baseworks/customers',
    '@baseworks/org',
    '@baseworks/sdk',
    '@baseworks/foldbase',
    '@hono/node-server',
    'hono',
    '@hono/zod-validator',
    'zod',
  ],
  external: ['@libsql/client', 'ioredis'],
})
