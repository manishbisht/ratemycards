import { SELF, env } from 'cloudflare:test'
import { signJwt } from '@clerk/backend/jwt'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * adminAuth's second credential: a Clerk session whose user row carries
 * is_admin, standing in for the shared ADMIN_TOKEN.
 *
 * auth.test.ts owns the shared-secret path and is deliberately not touched by
 * any of this -- if it ever needs an edit, the shape discriminator in
 * adminAuth.ts is wrong. What is pinned here is the *other* branch, plus the
 * fact that the two coexist on the same route.
 *
 * A *write* file: it creates banks.
 */

const base = 'http://api.test'
const AZP = 'http://localhost:5173'

async function mintToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  return signJwt(
    { iss: 'https://clerk.test.example', azp: AZP, iat: now - 5, nbf: now - 5, exp: now + 600, ...claims },
    JSON.parse(env.TEST_JWT_PRIVATE_KEY) as JsonWebKey,
    { algorithm: 'RS256', header: { kid: env.TEST_JWT_KID } },
  )
}

let adminToken = ''
let plainToken = ''
let unique = 0

function send(method: string, path: string, auth?: string, body?: unknown) {
  return SELF.fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth === undefined ? {} : { Authorization: auth }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** A fresh bank name per call, so a 409 can never be mistaken for a 201. */
function bank() {
  unique += 1
  return { name: `Admin Auth Bank ${unique}` }
}

beforeAll(async () => {
  adminToken = await mintToken({ sub: 'user_adminauth_admin', email: 'admin@test.example' })
  plainToken = await mintToken({ sub: 'user_adminauth_plain', email: 'plain@test.example' })

  // First contact is what creates the rows and runs the allowlist reconcile.
  await SELF.fetch(`${base}/v1/users/me`, { headers: { Authorization: `Bearer ${adminToken}` } })
  await SELF.fetch(`${base}/v1/users/me`, { headers: { Authorization: `Bearer ${plainToken}` } })
})

describe('adminAuth with a Clerk session', () => {
  it('lets an admin session write, exactly as the shared token does', async () => {
    const res = await send('POST', '/v1/banks', `Bearer ${adminToken}`, bank())
    expect(res.status).toBe(201)
  })

  it('refuses a signed-in non-admin with 403, not 401', async () => {
    const res = await send('POST', '/v1/banks', `Bearer ${plainToken}`, bank())
    expect(res.status).toBe(403)

    const body = (await res.json()) as any
    expect(body.error.code).toBe('forbidden')
    // A 401 would tell them to sign in again, which will never help.
    expect(body.error.message).toMatch(/admin/i)
  })

  /**
   * The session branch has to cover admin-only *reads* too, not just writes:
   * /v1/networks is guarded on every verb, and the panel is its only reader.
   */
  it('covers admin-only reads', async () => {
    expect((await send('GET', '/v1/networks', `Bearer ${adminToken}`)).status).toBe(200)
    expect((await send('GET', '/v1/networks', `Bearer ${plainToken}`)).status).toBe(403)
    expect((await send('GET', '/v1/networks')).status).toBe(401)
  })

  it('401s a JWT-shaped token that does not verify', async () => {
    const res = await send('POST', '/v1/banks', 'Bearer a.b.c', bank())
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe('unauthorized')
  })

  it('401s an expired session rather than 403ing it', async () => {
    const now = Math.floor(Date.now() / 1000)
    const expired = await signJwt(
      { iss: 'https://clerk.test.example', azp: AZP, sub: 'user_adminauth_admin', iat: now - 900, nbf: now - 900, exp: now - 600 },
      JSON.parse(env.TEST_JWT_PRIVATE_KEY) as JsonWebKey,
      { algorithm: 'RS256', header: { kid: env.TEST_JWT_KID } },
    )

    expect((await send('POST', '/v1/banks', `Bearer ${expired}`, bank())).status).toBe(401)
  })

  /**
   * The discriminator is on token shape, so the shared secret must still take
   * the hono/bearer-auth path untouched even now that a second branch exists.
   * auth.test.ts covers this properly; this is the coexistence check.
   */
  it('still accepts the shared token on the same route', async () => {
    const res = await send('POST', '/v1/banks', 'Bearer test-admin-token', bank())
    expect(res.status).toBe(201)
  })

  it('leaves the caller unidentified on the shared-token path', async () => {
    // Nothing to assert through the API -- the point is that it does not 500
    // for want of a user. A handler reading c.get('user') gets undefined.
    expect((await send('DELETE', '/v1/banks/bank_ffffffffffffffffffffffffffffffff', 'Bearer test-admin-token')).status).toBe(404)
  })
})
