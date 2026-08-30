import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/** The key id the tests sign with, and the one the stub JWKS publishes. */
const TEST_KID = 'test-signing-key'

/**
 * A throwaway RSA keypair, minted fresh on every run.
 *
 * The Worker verifies session tokens against Clerk's JWKS, so the tests hold
 * the private half, sign real tokens with it, and answer the Worker's JWKS
 * fetch with the public half (see `outboundService` below). That exercises the
 * genuine path -- signature, key id, expiry, authorized party -- rather than a
 * stub standing in for it. Mocking @clerk/backend would not work anyway:
 * SELF.fetch runs the Worker as its own bundle, which vi.mock does not reach.
 */
async function testJwtKeys(): Promise<{ jwks: string; privateJwk: string }> {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair

  // 'jwk' always yields a JsonWebKey; the union in the lib types covers the
  // binary formats too.
  const publicJwk = (await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey

  return {
    jwks: JSON.stringify({
      keys: [{ kid: TEST_KID, kty: 'RSA', alg: 'RS256', use: 'sig', n: publicJwk.n, e: publicJwk.e }],
    }),
    privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey)),
  }
}

export default defineConfig(async () => {
  // Exported from the package root -- the docstring in the package's own types
  // points at a "/config" subpath that is not in its exports map. The path is
  // relative to the project root, which is where vitest runs.
  const migrations = await readD1Migrations('./migrations')
  const jwt = await testJwtKeys()

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          /**
           * Answers the Worker's only outbound request -- Clerk's JWKS -- with
           * the public half of the keypair above. Anything else is refused
           * rather than allowed out, so a test can never quietly depend on the
           * network.
           */
          outboundService: (request: Request) =>
            new URL(request.url).pathname.endsWith('/jwks')
              ? new Response(jwt.jwks, { headers: { 'Content-Type': 'application/json' } })
              : new Response('unexpected outbound request', { status: 502 }),
          bindings: {
            // Read by test/setup.ts.
            TEST_MIGRATIONS: migrations,
            // Supplies the secrets without a .dev.vars file, so CI needs no setup.
            ADMIN_TOKEN: 'test-admin-token',
            CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_cmF0ZW15Y2FyZHMtdGVzdC13ZWJob29rLXNlY3JldCE=',
            // Never reaches Clerk: outboundService below answers the JWKS
            // request. It only has to be present, so the middleware takes its
            // configured path rather than the fails-closed one.
            CLERK_SECRET_KEY: 'sk_test_not-a-real-key',
            // Read by the tests to sign tokens. Never a real key.
            TEST_JWT_PRIVATE_KEY: jwt.privateJwk,
            TEST_JWT_KID: TEST_KID,
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  }
})
