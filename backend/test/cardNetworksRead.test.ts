import { SELF, env } from 'cloudflare:test'
import { signJwt } from '@clerk/backend/jwt'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * GET /v1/cards/:id/networks -- the admin read that the networks editor needs,
 * because PATCH /v1/cards/:id { networks } replaces the set rather than merging
 * and a UI cannot safely replace what it cannot see.
 *
 * A *write* file: it mints its own bank and cards rather than leaning on the
 * seed, so the counts asserted in cardsRead.test.ts are unaffected.
 */

const base = 'http://api.test'
const ADMIN = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }
const AZP = 'http://localhost:5173'

async function mintToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  return signJwt(
    { iss: 'https://clerk.test.example', azp: AZP, iat: now - 5, nbf: now - 5, exp: now + 600, ...claims },
    JSON.parse(env.TEST_JWT_PRIVATE_KEY) as JsonWebKey,
    { algorithm: 'RS256', header: { kid: env.TEST_JWT_KID } },
  )
}

let bankId = ''
/** Two networks, prefixes on both. */
let richCard = ''
/** On a network, but no prefixes on file -- a real and unselectable state. */
let bareCard = ''
/** On no networks at all. */
let emptyCard = ''
let adminToken = ''
let plainToken = ''

async function create(path: string, body: unknown) {
  const res = await SELF.fetch(`${base}${path}`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify(body),
  })
  expect(res.status, `${path} -> ${await res.clone().text()}`).toBe(201)
  return (await res.json()) as any
}

beforeAll(async () => {
  bankId = (await create('/v1/banks', { name: 'Card Networks Read Bank' })).id

  const card = (name: string, networks: unknown[]) => ({
    bankId,
    name,
    country: 'IN',
    joiningFee: 0,
    annualFee: 0,
    networks,
  })

  richCard = (
    await create(
      '/v1/cards',
      card('Rich', [
        // Deliberately given out of order, and with the higher prefix first,
        // so the ORDER BY in listCardNetworks is actually under test.
        { code: 'mastercard', bins: ['521234'] },
        { code: 'visa', bins: ['45678901', '412345'] },
      ]),
    )
  ).id

  bareCard = (await create('/v1/cards', card('Bare', [{ code: 'visa', bins: [] }]))).id
  emptyCard = (await create('/v1/cards', card('Empty', []))).id

  adminToken = await mintToken({ sub: 'user_cardnet_admin', email: 'admin@test.example' })
  plainToken = await mintToken({ sub: 'user_cardnet_plain', email: 'plain@test.example' })

  for (const token of [adminToken, plainToken]) {
    await SELF.fetch(`${base}/v1/users/me`, { headers: { Authorization: `Bearer ${token}` } })
  }
})

function get(cardId: string, auth?: string) {
  return SELF.fetch(`${base}/v1/cards/${cardId}/networks`, {
    headers: auth === undefined ? {} : { Authorization: auth },
  })
}

describe('GET /v1/cards/:id/networks', () => {
  it('returns each network with its prefixes, both sorted', async () => {
    const res = await get(richCard, ADMIN.Authorization)
    expect(res.status).toBe(200)

    expect(await res.json()).toEqual({
      data: [
        { network: 'mastercard', bins: ['521234'] },
        { network: 'visa', bins: ['412345', '45678901'] },
      ],
      total: 2,
    })
  })

  it('reports a network with no prefixes as an empty list, not an absence', async () => {
    const body = (await (await get(bareCard, ADMIN.Authorization)).json()) as any
    // `total` counts networks, not prefixes, so a bin-less network still counts.
    expect(body).toEqual({ data: [{ network: 'visa', bins: [] }], total: 1 })
  })

  it('returns an empty set for a card on no networks', async () => {
    expect(await (await get(emptyCard, ADMIN.Authorization)).json()).toEqual({ data: [], total: 0 })
  })

  it('round-trips what a PATCH replaced it with', async () => {
    // The contract the editor depends on: read, edit, write back the whole set.
    const res = await SELF.fetch(`${base}/v1/cards/${bareCard}`, {
      method: 'PATCH',
      headers: ADMIN,
      body: JSON.stringify({ networks: [{ code: 'rupay', bins: ['652345'] }] }),
    })
    expect(res.status).toBe(200)

    expect(await (await get(bareCard, ADMIN.Authorization)).json()).toEqual({
      data: [{ network: 'rupay', bins: ['652345'] }],
      total: 1,
    })
  })

  it('accepts an admin session as well as the shared token', async () => {
    expect((await get(richCard, `Bearer ${adminToken}`)).status).toBe(200)
  })

  it('refuses an anonymous caller and a signed-in non-admin', async () => {
    expect((await get(richCard)).status).toBe(401)
    expect((await get(richCard, `Bearer ${plainToken}`)).status).toBe(403)
  })

  it('404s an unknown card', async () => {
    const res = await get('card_ffffffffffffffffffffffffffffffff', ADMIN.Authorization)
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('not_found')
  })

  /** The prefixes must not have leaked onto the public card in the process. */
  it('leaves the public card free of networks and bins', async () => {
    const card = (await (await SELF.fetch(`${base}/v1/cards/${richCard}`)).json()) as any
    expect(card.networks).toBeUndefined()
    expect(card.bins).toBeUndefined()
    expect(JSON.stringify(card)).not.toContain('412345')
  })
})
