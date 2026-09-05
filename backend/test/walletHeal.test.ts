import { SELF, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { getWallet } from '../src/modules/wallet/queries'

/**
 * Migration 0015, the one-off repair for wallet rows that fell out of step with
 * the verifications behind them.
 *
 * The migration has already run by the time any test does -- against an empty
 * table, where it has nothing to do. So this builds the broken state it exists
 * for and replays the migration's own SQL over it, read out of TEST_MIGRATIONS
 * rather than copied here: a repair that is only tested as a paraphrase of
 * itself is not tested at all.
 *
 * A *write* file -- its own bank, cards and user.
 */

const base = 'http://api.test'
const ADMIN = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }

const USER_ID = 'user_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const PROVED_AT = '2026-09-01T10:00:00Z'

let strandedId = ''
let mismatchedId = ''

async function create(path: string, body: unknown) {
  const res = await SELF.fetch(`${base}${path}`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify(body),
  })
  expect(res.status, `${path} -> ${await res.clone().text()}`).toBe(201)
  return (await res.json()) as any
}

/** An attempt row as the verification module would have left it. */
function attempt(suffix: string, cardId: string, status: 'verified' | 'mismatched') {
  return env.DB.prepare(
    `INSERT INTO card_verifications
       (id, user_id, card_id, razorpay_order_id, razorpay_payment_id, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `ver_${suffix.padEnd(32, '0')}`,
    USER_ID,
    cardId,
    `order_heal_${suffix}`,
    `pay_heal_${suffix}`,
    status,
    PROVED_AT,
  )
}

beforeAll(async () => {
  const bank = await create('/v1/banks', { name: 'Healing Bank' })
  const card = (name: string) =>
    create('/v1/cards', { bankId: bank.id, name, country: 'IN', joiningFee: 0, annualFee: 0 })

  strandedId = (await card('Stranded One')).id
  mismatchedId = (await card('Mismatched One')).id

  await env.DB.prepare(
    `INSERT INTO users (id, clerk_id) VALUES (?, 'user_heal')`,
  )
    .bind(USER_ID)
    .run()

  await env.DB.batch([
    attempt('aaaa', strandedId, 'verified'),
    attempt('bbbb', mismatchedId, 'mismatched'),
    // The state the bug left behind: the card was removed and added back, so
    // the row was rewritten from scratch while the payment stayed on file.
    env.DB.prepare(
      `INSERT INTO wallet_cards (user_id, card_id, verification_status) VALUES (?, ?, 'failed')`,
    ).bind(USER_ID, strandedId),
    env.DB.prepare(
      `INSERT INTO wallet_cards (user_id, card_id, verification_status) VALUES (?, ?, 'failed')`,
    ).bind(USER_ID, mismatchedId),
  ])

  const repair = env.TEST_MIGRATIONS.find((migration) => migration.name.startsWith('0015'))
  expect(repair, 'migration 0015 should be on disk').toBeDefined()
  for (const query of repair!.queries) await env.DB.prepare(query).run()
})

describe('migration 0015', () => {
  it('gives back a verification the wallet row had lost', async () => {
    const wallet = await getWallet(env.DB, USER_ID)
    const entry = wallet.cards.find((c) => c.card.id === strandedId)

    expect(entry?.verificationStatus).toBe('verified')
    // Dated when the rupee was paid, not when the repair ran.
    expect(entry?.verifiedAt).toBe(PROVED_AT)
  })

  it('leaves a card whose only attempt was a mismatch alone', async () => {
    const wallet = await getWallet(env.DB, USER_ID)
    const entry = wallet.cards.find((c) => c.card.id === mismatchedId)

    expect(entry?.verificationStatus).toBe('failed')
    expect(entry?.verifiedAt).toBeNull()
  })
})
