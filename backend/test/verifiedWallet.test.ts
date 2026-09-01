import { SELF, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { getVerifiedWallet, getWallet } from '../src/modules/wallet/queries'

/**
 * A *write* file: it mints its own bank, cards and user.
 *
 * Calls the query directly rather than through a route -- the route that will
 * use it does not exist until Task 5, and this is where the filtering lives.
 */

const base = 'http://api.test'
const ADMIN = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }

let userId = ''
let verifiedId = ''
let unverifiedId = ''

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
  const bank = await create('/v1/banks', { name: 'Verified Wallet Bank' })
  const card = (name: string) =>
    create('/v1/cards', { bankId: bank.id, name, country: 'IN', joiningFee: 0, annualFee: 0 })

  verifiedId = (await card('Verified One')).id
  unverifiedId = (await card('Unverified One')).id

  await env.DB.prepare(
    `INSERT INTO users (id, clerk_id, handle)
     VALUES ('user_ffffffffffffffffffffffffffffffff', 'user_verified_wallet', 'walletowner')`,
  ).run()
  userId = 'user_ffffffffffffffffffffffffffffffff'

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO wallet_cards (user_id, card_id, verification_status, verified_at)
       VALUES (?, ?, 'verified', '2026-09-01T00:00:00Z')`,
    ).bind(userId, verifiedId),
    env.DB.prepare(
      `INSERT INTO wallet_cards (user_id, card_id, verification_status)
       VALUES (?, ?, 'unverified')`,
    ).bind(userId, unverifiedId),
  ])
})

describe('getVerifiedWallet', () => {
  it('returns only the verified cards', async () => {
    const wallet = await getVerifiedWallet(env.DB, userId)

    expect(wallet.cards.map((entry) => entry.card.id)).toEqual([verifiedId])
    expect(wallet.cards.every((entry) => entry.verificationStatus === 'verified')).toBe(true)
  })

  it('scores the verified set, not the whole wallet', async () => {
    const wallet = await getVerifiedWallet(env.DB, userId)
    expect(wallet.score.cardCount).toBe(1)
  })

  it('returns an empty wallet, scored, for someone with nothing verified', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, clerk_id) VALUES ('user_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'user_nothing')`,
    ).run()

    const wallet = await getVerifiedWallet(env.DB, 'user_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    expect(wallet.cards).toEqual([])
    expect(wallet.score.cardCount).toBe(0)
    expect(wallet.score.score).toBe(0)
  })

  it('genuinely filters: verified wallet excludes unverified cards while full wallet includes them', async () => {
    const verifiedWallet = await getVerifiedWallet(env.DB, userId)
    const fullWallet = await getWallet(env.DB, userId)

    // The full wallet has both cards, but verified wallet has only the verified one
    expect(fullWallet.cards.length).toBe(2)
    expect(verifiedWallet.cards.length).toBe(1)

    // The full wallet includes the unverified card, but verified wallet does not
    const fullWalletIds = fullWallet.cards.map((entry) => entry.card.id)
    const verifiedWalletIds = verifiedWallet.cards.map((entry) => entry.card.id)
    expect(fullWalletIds).toContain(unverifiedId)
    expect(verifiedWalletIds).not.toContain(unverifiedId)

    // The scores differ: full wallet scores both cards, verified wallet scores only one
    expect(fullWallet.score.cardCount).toBe(2)
    expect(verifiedWallet.score.cardCount).toBe(1)
  })
})
