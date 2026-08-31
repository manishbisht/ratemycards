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

/**
 * The Razorpay keys the tests run against. Not real, and never sent anywhere:
 * `razorpayStub` answers every api.razorpay.com request in-process.
 */
export const RAZORPAY_TEST_KEY_ID = 'rzp_test_stub'
export const RAZORPAY_TEST_KEY_SECRET = 'stub_secret_do_not_use'

/**
 * Stands in for the Razorpay REST API, driven entirely by the payment id so it
 * needs no state between calls. A test asks for the case it wants by naming it:
 *
 *   pay_card_visa_authorized   -> a card payment on Visa, authorised not captured
 *   pay_card_mastercard_captured -> ... on Mastercard, already captured
 *   pay_upi_authorized         -> not a card payment at all
 *
 * Kept here rather than in a test file because the Worker runs as its own
 * bundle under SELF.fetch, so vi.mock cannot reach its `fetch`.
 */
function razorpayStub(request: Request, url: URL): Response {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  if (request.method === 'POST' && url.pathname === '/v1/orders') {
    return json({
      id: `order_stub_${Math.random().toString(36).slice(2, 10)}`,
      amount: 100,
      currency: 'INR',
      status: 'created',
    })
  }

  const refund = url.pathname.match(/^\/v1\/payments\/([^/]+)\/refund$/)
  if (request.method === 'POST' && refund) {
    return json({ id: 'rfnd_stub', payment_id: refund[1], status: 'processed' })
  }

  const card = url.pathname.match(/^\/v1\/payments\/([^/]+)\/card$/)
  if (card) {
    const parts = card[1].split('_')
    if (!parts.includes('card')) return json({ error: { description: 'not a card payment' } }, 400)
    const NETWORKS: Record<string, string> = {
      visa: 'Visa',
      mastercard: 'MasterCard',
      rupay: 'RuPay',
      amex: 'American Express',
      diners: 'Diners Club',
      bajaj: 'Bajaj Finserv',
    }
    const network = parts.map((p) => NETWORKS[p]).find(Boolean) ?? 'Visa'
    return json({
      id: 'card_stub',
      last4: '4321',
      network,
      type: 'credit',
      issuer: 'HDFC',
      international: false,
    })
  }

  const payment = url.pathname.match(/^\/v1\/payments\/([^/]+)$/)
  if (payment) {
    const id = payment[1]
    const parts = id.split('_')
    // The order this payment belongs to is echoed from a `for` segment when the
    // test needs a mismatch; otherwise it agrees with whatever asked for it.
    const forIndex = parts.indexOf('for')
    return json({
      id,
      status: parts.includes('captured') ? 'captured' : 'authorized',
      method: parts.includes('card') ? 'card' : 'upi',
      order_id: forIndex >= 0 ? parts.slice(forIndex + 1).join('_') : null,
      amount: 100,
    })
  }

  return json({ error: { description: `stub has no route for ${url.pathname}` } }, 404)
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
          outboundService: (request: Request) => {
            const url = new URL(request.url)
            if (url.pathname.endsWith('/jwks')) {
              return new Response(jwt.jwks, { headers: { 'Content-Type': 'application/json' } })
            }
            if (url.hostname === 'api.razorpay.com') return razorpayStub(request, url)
            return new Response('unexpected outbound request', { status: 502 })
          },
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
            // Never reaches Razorpay -- razorpayStub answers instead. The
            // secret is what the tests sign their callback signatures with, so
            // it has to match what the Worker verifies against.
            RAZORPAY_KEY_ID: RAZORPAY_TEST_KEY_ID,
            RAZORPAY_KEY_SECRET: RAZORPAY_TEST_KEY_SECRET,
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  }
})
