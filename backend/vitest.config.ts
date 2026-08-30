import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  // Exported from the package root -- the docstring in the package's own types
  // points at a "/config" subpath that is not in its exports map. The path is
  // relative to the project root, which is where vitest runs.
  const migrations = await readD1Migrations('./migrations')

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            // Read by test/setup.ts.
            TEST_MIGRATIONS: migrations,
            // Supplies the secret without a .dev.vars file, so CI needs no setup.
            ADMIN_TOKEN: 'test-admin-token',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  }
})
