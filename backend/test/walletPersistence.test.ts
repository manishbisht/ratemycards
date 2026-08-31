import { SELF, env } from 'cloudflare:test'
import { signJwt } from '@clerk/backend/jwt'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Stored wallets: the users table, session auth, and the wallet endpoints that
 * hang off it.
 *
 * A *write* file. Storage isolation is per file, not per test, so these rows
 * are invisible to cardsRead.test.ts and its seed-count assertions -- and the
 * cards created here belong to a bank created here, for the same reason.
 *
 * The tokens are real: signed here with the private key vitest.config.ts
 * generated, and verified by the Worker against the JWKS that the same config
 * serves back over its stubbed outbound fetch. So these exercise the actual
 * signature, key-id, expiry and authorized-party checks rather than a stub
 * standing in for them.
 */

const base = 'http://api.test'
const ADMIN = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }

/** Must be one of ALLOWED_ORIGINS, which is what authorizedParties is built from. */
const AZP = 'http://localhost:5173'

async function mintToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  return signJwt(
    {
      iss: 'https://clerk.test.example',
      azp: AZP,
      iat: now - 5,
      nbf: now - 5,
      exp: now + 600,
      ...claims,
    },
    JSON.parse(env.TEST_JWT_PRIVATE_KEY) as JsonWebKey,
    // The kid is what the SDK looks the signing key up by, so a token without
    // one -- or with an unknown one -- is rejected before the signature is even
    // checked.
    { algorithm: 'RS256', header: { kid: env.TEST_JWT_KID } },
  )
}

let tokenAda = ''
let tokenBob = ''
let cardA = ''
let cardB = ''

function as(token: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  }
}

/**
 * Seeds a verified card straight into the table.
 *
 * Deliberately not over the API: PATCH /v1/wallet/cards/:cardId refuses to set
 * 'verified' precisely so a client cannot, and the earned path needs a real
 * Razorpay payment (exercised in verification.test.ts). These tests only need
 * the resulting state to assert something else about it.
 */
async function forceVerified(clerkId: string, cardId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE wallet_cards
     SET verification_status = 'verified',
         verified_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE card_id = ? AND user_id = (SELECT id FROM users WHERE clerk_id = ?)`,
  )
    .bind(cardId, clerkId)
    .run()
}

beforeAll(async () => {
  tokenAda = await mintToken({
    sub: 'clerk_ada',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
  })
  tokenBob = await mintToken({ sub: 'clerk_bob', email: 'bob@example.com', name: 'Bob Vance' })

  const bank = await SELF.fetch(`${base}/v1/banks`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify({ name: 'Wallet Persistence Test Bank' }),
  })
  const bankId = ((await bank.json()) as any).id

  const makeCard = async (name: string) => {
    const res = await SELF.fetch(`${base}/v1/cards`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ bankId, name, country: 'IN' }),
    })
    return ((await res.json()) as any).id
  }

  cardA = await makeCard('Persistence Card A')
  cardB = await makeCard('Persistence Card B')
})

describe('session auth', () => {
  it('rejects a wallet read with no token', async () => {
    const res = await SELF.fetch(`${base}/v1/wallet`)
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe('unauthorized')
  })

  it('rejects a token that does not verify', async () => {
    const res = await SELF.fetch(`${base}/v1/wallet`, as('not-a-real-token'))
    expect(res.status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const expired = await mintToken({ sub: 'clerk_ada', exp: now - 60, nbf: now - 120, iat: now - 120 })

    expect((await SELF.fetch(`${base}/v1/wallet`, as(expired))).status).toBe(401)
  })

  /**
   * authorizedParties is what stops a token minted for someone else's Clerk
   * app from being spent here, so it is worth pinning rather than trusting.
   */
  it('rejects a token issued for a different party', async () => {
    const foreign = await mintToken({ sub: 'clerk_ada', azp: 'https://not-our-app.example' })

    expect((await SELF.fetch(`${base}/v1/wallet`, as(foreign))).status).toBe(401)
  })

  /**
   * Key lookup is by `kid`, which is what makes a Clerk key rotation a
   * non-event: an unseen id forces a fresh JWKS fetch rather than a failure.
   * Here the refetch still will not produce the id, so it is rejected.
   */
  it('rejects a token whose key id is not in the JWKS', async () => {
    const now = Math.floor(Date.now() / 1000)
    const unknown = await signJwt(
      { sub: 'clerk_ada', iss: 'https://clerk.test.example', azp: AZP, iat: now, nbf: now, exp: now + 600 },
      JSON.parse(env.TEST_JWT_PRIVATE_KEY) as JsonWebKey,
      { algorithm: 'RS256', header: { kid: 'a-key-clerk-never-published' } },
    )

    expect((await SELF.fetch(`${base}/v1/wallet`, as(unknown))).status).toBe(401)
  })

  it('rejects a token signed with the wrong key', async () => {
    const { privateKey } = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair

    const now = Math.floor(Date.now() / 1000)
    const forged = await signJwt(
      { sub: 'clerk_ada', iss: 'https://clerk.test.example', azp: AZP, iat: now, nbf: now, exp: now + 600 },
      (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey,
      // Claims the key id the JWKS publishes, so this fails on the signature
      // itself rather than on an unrecognised kid.
      { algorithm: 'RS256', header: { kid: env.TEST_JWT_KID } },
    )

    expect((await SELF.fetch(`${base}/v1/wallet`, as(forged))).status).toBe(401)
  })

  /**
   * An invalid token on an optional-auth route is still rejected. Quietly
   * downgrading it to anonymous would turn an expired session into a
   * mysteriously empty wallet instead of a prompt to sign in again.
   */
  it('rejects a bad token on the public cards route rather than ignoring it', async () => {
    const res = await SELF.fetch(`${base}/v1/cards`, as('not-a-real-token'))
    expect(res.status).toBe(401)
  })

  it('creates the user row on first authenticated request', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE clerk_id = ?')
      .bind('clerk_ada')
      .first<{ n: number }>()
    expect(before?.n).toBe(0)

    expect((await SELF.fetch(`${base}/v1/wallet`, as(tokenAda))).status).toBe(200)

    const row = await env.DB.prepare('SELECT id, email, name FROM users WHERE clerk_id = ?')
      .bind('clerk_ada')
      .first<{ id: string; email: string; name: string }>()
    expect(row?.email).toBe('ada@example.com')
    expect(row?.name).toBe('Ada Lovelace')
    // Our id, not Clerk's: same prefix, different shape.
    expect(row?.id).toMatch(/^user_[0-9a-f]{32}$/)
  })

  it('reuses the row on later requests rather than inserting again', async () => {
    await SELF.fetch(`${base}/v1/wallet`, as(tokenAda))
    await SELF.fetch(`${base}/v1/wallet`, as(tokenAda))

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE clerk_id = ?')
      .bind('clerk_ada')
      .first<{ n: number }>()
    expect(count?.n).toBe(1)
  })

  it('returns the caller their own row', async () => {
    const res = await SELF.fetch(`${base}/v1/users/me`, as(tokenAda))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.email).toBe('ada@example.com')
    // The Clerk id is an internal detail and must not leak out.
    expect(body).not.toHaveProperty('clerkId')
  })
})

describe('wallet writes', () => {
  it('starts empty and scores zero', async () => {
    const res = await SELF.fetch(`${base}/v1/wallet`, as(tokenBob))
    const body = (await res.json()) as any
    expect(body.cards).toEqual([])
    expect(body.score.score).toBe(0)
  })

  it('adds a card and returns the wallet', async () => {
    const res = await SELF.fetch(`${base}/v1/wallet/cards/${cardA}`, as(tokenBob, { method: 'PUT' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as any
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0].card.id).toBe(cardA)
    expect(body.cards[0].verificationStatus).toBe('unverified')
    expect(body.cards[0].verifiedAt).toBeNull()
  })

  it('is idempotent on a repeated add', async () => {
    await SELF.fetch(`${base}/v1/wallet/cards/${cardA}`, as(tokenBob, { method: 'PUT' }))
    const res = await SELF.fetch(`${base}/v1/wallet`, as(tokenBob))
    expect(((await res.json()) as any).cards).toHaveLength(1)
  })

  it('rejects a malformed card id before it reaches SQL', async () => {
    const res = await SELF.fetch(`${base}/v1/wallet/cards/not-a-card`, as(tokenBob, { method: 'PUT' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('validation_error')
  })

  it('404s a card that does not exist rather than failing on the foreign key', async () => {
    const missing = `card_${'0'.repeat(32)}`
    const res = await SELF.fetch(`${base}/v1/wallet/cards/${missing}`, as(tokenBob, { method: 'PUT' }))
    expect(res.status).toBe(404)
  })

  it('records a status the client is allowed to report', async () => {
    const res = await SELF.fetch(
      `${base}/v1/wallet/cards/${cardA}`,
      as(tokenBob, { method: 'PATCH', body: JSON.stringify({ status: 'pending' }) }),
    )
    expect(res.status).toBe(200)

    const card = ((await res.json()) as any).cards.find((entry: any) => entry.card.id === cardA)
    expect(card.verificationStatus).toBe('pending')
    expect(card.verifiedAt).toBeNull()
  })

  /**
   * The hole this closes: while this endpoint accepted 'verified', the whole
   * 1-rupee Razorpay check was bypassable with one curl.
   */
  it('refuses to let a client declare itself verified', async () => {
    const res = await SELF.fetch(
      `${base}/v1/wallet/cards/${cardA}`,
      as(tokenBob, { method: 'PATCH', body: JSON.stringify({ status: 'verified' }) }),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.details[0]).toMatch(/completing a card verification/)

    const wallet = (await (await SELF.fetch(`${base}/v1/wallet`, as(tokenBob))).json()) as any
    const card = wallet.cards.find((entry: any) => entry.card.id === cardA)
    expect(card.verificationStatus).not.toBe('verified')
  })

  it('stamps the date when a verification is earned', async () => {
    await forceVerified('clerk_bob', cardA)

    const wallet = (await (await SELF.fetch(`${base}/v1/wallet`, as(tokenBob))).json()) as any
    const card = wallet.cards.find((entry: any) => entry.card.id === cardA)
    expect(card.verificationStatus).toBe('verified')
    expect(card.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('clears the date when the status moves off verified', async () => {
    const res = await SELF.fetch(
      `${base}/v1/wallet/cards/${cardA}`,
      as(tokenBob, { method: 'PATCH', body: JSON.stringify({ status: 'pending' }) }),
    )
    const card = ((await res.json()) as any).cards.find((entry: any) => entry.card.id === cardA)
    expect(card.verificationStatus).toBe('pending')
    expect(card.verifiedAt).toBeNull()
  })

  it('rejects a status outside the allowed set', async () => {
    const res = await SELF.fetch(
      `${base}/v1/wallet/cards/${cardA}`,
      as(tokenBob, { method: 'PATCH', body: JSON.stringify({ status: 'definitely-verified' }) }),
    )
    expect(res.status).toBe(400)
  })

  it('404s a status write for a card the caller does not hold', async () => {
    const res = await SELF.fetch(
      `${base}/v1/wallet/cards/${cardB}`,
      as(tokenBob, { method: 'PATCH', body: JSON.stringify({ status: 'pending' }) }),
    )
    expect(res.status).toBe(404)
  })

  it('removes a card, and removing it again is still 204', async () => {
    expect((await SELF.fetch(`${base}/v1/wallet/cards/${cardA}`, as(tokenBob, { method: 'DELETE' }))).status).toBe(204)
    expect((await SELF.fetch(`${base}/v1/wallet/cards/${cardA}`, as(tokenBob, { method: 'DELETE' }))).status).toBe(204)

    const res = await SELF.fetch(`${base}/v1/wallet`, as(tokenBob))
    expect(((await res.json()) as any).cards).toEqual([])
  })
})

describe('wallets are per user', () => {
  it('does not show one caller another caller\'s cards', async () => {
    await SELF.fetch(`${base}/v1/wallet/cards/${cardA}`, as(tokenAda, { method: 'PUT' }))

    const bob = await SELF.fetch(`${base}/v1/wallet`, as(tokenBob))
    expect(((await bob.json()) as any).cards).toEqual([])

    const ada = await SELF.fetch(`${base}/v1/wallet`, as(tokenAda))
    expect(((await ada.json()) as any).cards).toHaveLength(1)
  })
})

describe('merge at sign-in', () => {
  it('unions local picks with what the account already holds', async () => {
    // Ada already holds cardA from the previous block.
    const res = await SELF.fetch(
      `${base}/v1/wallet/merge`,
      as(tokenAda, { method: 'POST', body: JSON.stringify({ cardIds: [cardB] }) }),
    )
    expect(res.status).toBe(200)

    const ids = ((await res.json()) as any).cards.map((entry: any) => entry.card.id)
    expect(ids).toContain(cardA)
    expect(ids).toContain(cardB)
  })

  it('leaves an already-verified card alone rather than downgrading it', async () => {
    await forceVerified('clerk_ada', cardB)

    // A fresh browser re-sending the same card must not reset its status.
    const res = await SELF.fetch(
      `${base}/v1/wallet/merge`,
      as(tokenAda, { method: 'POST', body: JSON.stringify({ cardIds: [cardB] }) }),
    )
    const card = ((await res.json()) as any).cards.find((entry: any) => entry.card.id === cardB)
    expect(card.verificationStatus).toBe('verified')
  })

  it('drops ids the catalog does not know instead of failing the whole merge', async () => {
    const missing = `card_${'1'.repeat(32)}`
    const res = await SELF.fetch(
      `${base}/v1/wallet/merge`,
      as(tokenAda, { method: 'POST', body: JSON.stringify({ cardIds: [missing] }) }),
    )
    expect(res.status).toBe(200)

    const ids = ((await res.json()) as any).cards.map((entry: any) => entry.card.id)
    expect(ids).not.toContain(missing)
  })

  it('rejects a body that is not a list of card ids', async () => {
    const res = await SELF.fetch(
      `${base}/v1/wallet/merge`,
      as(tokenAda, { method: 'POST', body: JSON.stringify({ cardIds: 'nope' }) }),
    )
    expect(res.status).toBe(400)
  })
})

describe('the cards API serves both audiences', () => {
  it('omits the wallet block entirely for an anonymous caller', async () => {
    const res = await SELF.fetch(`${base}/v1/cards?ids=${cardA}`)
    const card = ((await res.json()) as any).data[0]
    expect(card).not.toHaveProperty('wallet')
  })

  it('reports held and verified state for a signed-in caller', async () => {
    const res = await SELF.fetch(`${base}/v1/cards?ids=${cardA},${cardB}`, as(tokenAda))
    const byId = Object.fromEntries(
      ((await res.json()) as any).data.map((card: any) => [card.id, card]),
    )

    expect(byId[cardA].wallet.inWallet).toBe(true)
    expect(byId[cardB].wallet.verificationStatus).toBe('verified')
  })

  it('marks a card the caller does not hold as not in the wallet', async () => {
    const res = await SELF.fetch(`${base}/v1/cards?ids=${cardA}`, as(tokenBob))
    const card = ((await res.json()) as any).data[0]
    expect(card.wallet.inWallet).toBe(false)
    expect(card.wallet.verificationStatus).toBe('unverified')
  })

  it('still hides the rating from a signed-in caller', async () => {
    const res = await SELF.fetch(`${base}/v1/cards?ids=${cardA}`, as(tokenAda))
    expect(((await res.json()) as any).data[0]).not.toHaveProperty('rating')
  })

  it('carries the wallet block on a single-card read too', async () => {
    const res = await SELF.fetch(`${base}/v1/cards/${cardA}`, as(tokenAda))
    expect(((await res.json()) as any).wallet.inWallet).toBe(true)
  })


  it('marks a card the caller does not hold as not in the wallet', async () => {
    const res = await SELF.fetch(`${base}/v1/cards?ids=${cardA}`, as(tokenBob))
    const card = ((await res.json()) as any).data[0]
    expect(card.wallet.inWallet).toBe(false)
    expect(card.wallet.verificationStatus).toBe('unverified')
  })

  it('still hides the rating from a signed-in caller', async () => {
    const res = await SELF.fetch(`${base}/v1/cards?ids=${cardA}`, as(tokenAda))
    expect(((await res.json()) as any).data[0]).not.toHaveProperty('rating')
  })

  it('carries the wallet block on a single-card read too', async () => {
    const res = await SELF.fetch(`${base}/v1/cards/${cardA}`, as(tokenAda))
    expect(((await res.json()) as any).wallet.inWallet).toBe(true)
  })

  /**
   * The wallet join adds a bind to the page query but not to the networks
   * query beside it in the batch. If those two bind lists ever drift, this is
   * where it shows: the networks would attach to the wrong card, or the filter
   * would silently select a different page.
   */
  /**
   * A signed-in caller gets one extra key -- `wallet` -- and nothing else. In
   * particular, having a session does not unlock the networks or BIN prefixes
   * behind a card; those are not on this payload for anyone.
   */
  it('adds the wallet block and nothing else for a signed-in caller', async () => {
    await SELF.fetch(`${base}/v1/cards/${cardA}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ networks: ['visa', 'rupay'] }),
    })

    const res = await SELF.fetch(`${base}/v1/cards?ids=${cardA}`, as(tokenAda))
    const card = ((await res.json()) as any).data[0]

    expect(Object.keys(card).sort()).toEqual([
      'annualFee',
      'bank',
      'country',
      'id',
      'isActive',
      'issuer',
      'joiningFee',
      'name',
      'selectable',
      'type',
      'wallet',
    ])
    expect(card.wallet.inWallet).toBe(true)
  })
})
