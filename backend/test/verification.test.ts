import { SELF, env } from 'cloudflare:test'
import { signJwt } from '@clerk/backend/jwt'
import { beforeAll, describe, expect, it } from 'vitest'
import { isValidCheckoutSignature } from '../src/modules/verification/razorpay'
import { networkCodeFor } from '../src/modules/verification/verificationTypes'

/**
 * Card verification: the 1-rupee Razorpay flow behind wallet_cards.
 *
 * A *write* file -- it creates its own bank, cards and users, so nothing here
 * disturbs the seed counts asserted in cardsRead.test.ts.
 *
 * Razorpay itself is answered by `razorpayStub` in vitest.config.ts, driven by
 * the payment id: `pay_card_visa_authorized` is a Visa card payment that was
 * authorised and not captured. The callback signatures are real HMACs computed
 * here with the same secret the Worker verifies against, so the signature path
 * is genuinely exercised rather than stubbed past.
 */

const base = 'http://api.test'
const ADMIN = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }
const AZP = 'http://localhost:5173'

/** Must match RAZORPAY_KEY_SECRET in vitest.config.ts. */
const KEY_SECRET = 'stub_secret_do_not_use'

async function mintToken(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    { iss: 'https://clerk.test.example', azp: AZP, iat: now - 5, nbf: now - 5, exp: now + 600, sub },
    JSON.parse(env.TEST_JWT_PRIVATE_KEY) as JsonWebKey,
    { algorithm: 'RS256', header: { kid: env.TEST_JWT_KID } },
  )
}

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

/** The signature Razorpay would send for this pairing. */
async function sign(orderId: string, paymentId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(KEY_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${orderId}|${paymentId}`),
  )
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

let token = ''
let otherToken = ''
let bankId = ''
let visaCard = ''
let rupayCard = ''
let networklessCard = ''

async function json(res: Response) {
  return (await res.json()) as any
}

/**
 * A prefix that satisfies each network's seeded glob rule (migration 0010),
 * so `freshCard` can hand the write path a BIN the admin validation actually
 * accepts rather than an arbitrary digit string.
 */
const SAMPLE_BIN: Record<string, string> = {
  visa: '411111',
  mastercard: '511111',
  amex: '341111',
  diners: '361111',
  rupay: '650000',
}

/**
 * A brand new card, held by the caller and on `networks`.
 *
 * Every test that verifies needs its own: a card can only be proved once, so
 * sharing one would make the tests order-dependent.
 */
async function freshCard(name: string, networks: string[] = ['visa']): Promise<string> {
  const card = await json(
    await SELF.fetch(`${base}/v1/cards`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({
        bankId,
        name,
        country: 'IN',
        // A real prefix, not []: starting a verification now requires one (see
        // the "no BIN prefixes" rejection below), and these cards exist to be
        // walked through a verification.
        networks: networks.map((code) => ({ code, bins: [SAMPLE_BIN[code] ?? '411111'] })),
      }),
    }),
  )
  await SELF.fetch(`${base}/v1/wallet/cards/${card.id}`, as(token, { method: 'PUT' }))
  return card.id
}

/** Walks a card all the way to a settled verification and returns the outcome. */
async function verifyWith(cardId: string, paymentId: string, sessionToken = token) {
  const start = await json(
    await SELF.fetch(
      `${base}/v1/verifications`,
      as(sessionToken, { method: 'POST', body: JSON.stringify({ cardId }) }),
    ),
  )

  const res = await SELF.fetch(
    `${base}/v1/verifications/${start.verificationId}/confirm`,
    as(sessionToken, {
      method: 'POST',
      body: JSON.stringify({
        razorpay_payment_id: paymentId,
        razorpay_order_id: start.orderId,
        razorpay_signature: await sign(start.orderId, paymentId),
      }),
    }),
  )

  return { start, res, body: await json(res) }
}

beforeAll(async () => {
  token = await mintToken('clerk_verifier')
  otherToken = await mintToken('clerk_intruder')

  bankId = (
    await json(
      await SELF.fetch(`${base}/v1/banks`, {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify({ name: 'Verification Test Bank' }),
      }),
    )
  ).id

  const make = async (name: string, networks?: string[]) =>
    (
      await json(
        await SELF.fetch(`${base}/v1/cards`, {
          method: 'POST',
          headers: ADMIN,
          body: JSON.stringify({
            bankId,
            name,
            country: 'IN',
            ...(networks ? { networks: networks.map((code) => ({ code, bins: [] })) } : {}),
          }),
        }),
      )
    ).id

  visaCard = await make('Probe Visa', ['visa'])
  rupayCard = await make('Probe RuPay', ['rupay'])
  networklessCard = await make('Probe Networkless')

  // Real BINs for the visa card, so the order response has iins to hand over.
  for (const prefix of ['412345', '498765']) {
    await env.DB.prepare(
      `INSERT INTO card_bins (card_id, network_id, bin_prefix)
       SELECT ?, id, ? FROM networks WHERE code = ?`,
    )
      .bind(visaCard, prefix, 'visa')
      .run()
  }

  // Both users hold every card, so wallet membership is never the thing failing.
  for (const t of [token, otherToken]) {
    for (const id of [visaCard, rupayCard, networklessCard]) {
      await SELF.fetch(`${base}/v1/wallet/cards/${id}`, as(t, { method: 'PUT' }))
    }
  }
})

describe('network mapping', () => {
  it('maps the names Razorpay actually sends', () => {
    expect(networkCodeFor('Visa')).toBe('visa')
    expect(networkCodeFor('MasterCard')).toBe('mastercard')
    expect(networkCodeFor('RuPay')).toBe('rupay')
    expect(networkCodeFor('American Express')).toBe('amex')
    expect(networkCodeFor('Diners Club')).toBe('diners')
  })

  it('is tolerant of case and spacing', () => {
    expect(networkCodeFor('american express')).toBe('amex')
    expect(networkCodeFor('AmericanExpress')).toBe('amex')
    expect(networkCodeFor('MASTERCARD')).toBe('mastercard')
  })

  it('returns null for anything it does not know, rather than guessing', () => {
    expect(networkCodeFor('Bajaj Finserv')).toBeNull()
    expect(networkCodeFor('')).toBeNull()
  })
})

describe('checkout signature', () => {
  const orderId = 'order_sig'
  const paymentId = 'pay_sig'

  it('accepts the signature Razorpay would send', async () => {
    const signature = await sign(orderId, paymentId)
    expect(
      await isValidCheckoutSignature({ keySecret: KEY_SECRET, orderId, paymentId, signature }),
    ).toBe(true)
  })

  it('rejects a signature for a different order', async () => {
    const signature = await sign('order_other', paymentId)
    expect(
      await isValidCheckoutSignature({ keySecret: KEY_SECRET, orderId, paymentId, signature }),
    ).toBe(false)
  })

  it('rejects a signature for a different payment', async () => {
    const signature = await sign(orderId, 'pay_other')
    expect(
      await isValidCheckoutSignature({ keySecret: KEY_SECRET, orderId, paymentId, signature }),
    ).toBe(false)
  })

  it('rejects a signature made with the wrong secret', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('not-the-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${orderId}|${paymentId}`),
    )
    const signature = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')

    expect(
      await isValidCheckoutSignature({ keySecret: KEY_SECRET, orderId, paymentId, signature }),
    ).toBe(false)
  })

  it('rejects a single flipped character', async () => {
    const good = await sign(orderId, paymentId)
    const bad = `${good.slice(0, -1)}${good.endsWith('a') ? 'b' : 'a'}`
    expect(
      await isValidCheckoutSignature({ keySecret: KEY_SECRET, orderId, paymentId, signature: bad }),
    ).toBe(false)
  })
})

describe('POST /v1/verifications', () => {
  it('rejects an anonymous caller', async () => {
    const res = await SELF.fetch(`${base}/v1/verifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId: visaCard }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a malformed card id', async () => {
    const res = await SELF.fetch(
      `${base}/v1/verifications`,
      as(token, { method: 'POST', body: JSON.stringify({ cardId: 'nope' }) }),
    )
    expect(res.status).toBe(400)
  })

  it('404s a card that does not exist', async () => {
    const res = await SELF.fetch(
      `${base}/v1/verifications`,
      as(token, {
        method: 'POST',
        body: JSON.stringify({ cardId: 'card_00000000000000000000000000000000' }),
      }),
    )
    expect(res.status).toBe(404)
  })

  it('mints an order and hands back this card\'s BINs', async () => {
    const res = await SELF.fetch(
      `${base}/v1/verifications`,
      as(token, { method: 'POST', body: JSON.stringify({ cardId: visaCard }) }),
    )
    expect(res.status).toBe(201)

    const body = await json(res)
    expect(body.orderId).toMatch(/^order_/)
    expect(body.verificationId).toMatch(/^ver_[0-9a-f]{32}$/)
    expect(body.amount).toBe(100)
    expect(body.currency).toBe('INR')
    expect(body.allowed.iins).toEqual(['412345', '498765'])
    expect(body.allowed.networks).toEqual(['visa'])
  })

  it('never leaks the key secret', async () => {
    const res = await SELF.fetch(
      `${base}/v1/verifications`,
      as(token, { method: 'POST', body: JSON.stringify({ cardId: visaCard }) }),
    )
    const text = JSON.stringify(await json(res))
    expect(text).toContain('rzp_test_stub')
    expect(text).not.toContain(KEY_SECRET)
  })

  it('refuses a card with networks but no BIN prefixes on file', async () => {
    const res = await SELF.fetch(
      `${base}/v1/verifications`,
      as(token, { method: 'POST', body: JSON.stringify({ cardId: rupayCard }) }),
    )
    expect(res.status).toBe(400)
    expect((await json(res)).error.details[0]).toMatch(/No BIN prefixes are on file/)
  })

  it('refuses a card with no networks at all -- there is nothing to match', async () => {
    const res = await SELF.fetch(
      `${base}/v1/verifications`,
      as(token, { method: 'POST', body: JSON.stringify({ cardId: networklessCard }) }),
    )
    expect(res.status).toBe(400)
    expect((await json(res)).error.details[0]).toMatch(/No payment networks/)
  })

  it('moves the wallet card to pending while the modal is up', async () => {
    const cardId = await freshCard('Probe Pending')
    await SELF.fetch(
      `${base}/v1/verifications`,
      as(token, { method: 'POST', body: JSON.stringify({ cardId }) }),
    )
    const wallet = await json(await SELF.fetch(`${base}/v1/wallet`, as(token)))
    expect(wallet.cards.find((c: any) => c.card.id === cardId).verificationStatus).toBe('pending')
  })
})

describe('POST /v1/verifications/:id/confirm', () => {
  it('verifies a card whose network matches', async () => {
    const { res, body } = await verifyWith(visaCard, 'pay_card_visa_authorized')

    expect(res.status).toBe(200)
    expect(body.status).toBe('verified')
    expect(body.card.network).toBe('Visa')
    expect(body.card.last4).toBe('4321')

    const wallet = await json(await SELF.fetch(`${base}/v1/wallet`, as(token)))
    const entry = wallet.cards.find((c: any) => c.card.id === visaCard)
    expect(entry.verificationStatus).toBe('verified')
    expect(entry.verifiedAt).not.toBeNull()
  })

  it('leaves an uncaptured payment to void rather than refunding it', async () => {
    // Not the shared rupayCard: that one is deliberately bin-less, to be the
    // fixture for the "no BIN prefixes" rejection above, and can no longer
    // start a verification at all.
    const cardId = await freshCard('Probe Void', ['rupay'])
    const { body } = await verifyWith(cardId, 'pay_card_rupay_authorized')
    expect(body.status).toBe('verified')
    expect(body.releaseState).toBe('voided')
  })

  it('refunds one that arrived already captured', async () => {
    const cardId = await freshCard('Probe Captured')

    const { body } = await verifyWith(cardId, 'pay_card_visa_captured')
    expect(body.status).toBe('verified')
    expect(body.releaseState).toBe('refunded')
  })

  it('rejects a card on the wrong network and does NOT mark it verified', async () => {
    const cardId = await freshCard('Probe Mismatch')

    // A Mastercard was presented for a Visa-only card.
    const { res, body } = await verifyWith(cardId, 'pay_card_mastercard_authorized')

    expect(res.status).toBe(422)
    expect(body.status).toBe('mismatched')
    expect(body.reason).toBe('network_mismatch:mastercard')

    const wallet = await json(await SELF.fetch(`${base}/v1/wallet`, as(token)))
    expect(wallet.cards.find((c: any) => c.card.id === cardId).verificationStatus).toBe('failed')
  })

  it('gives the rupee back even when the card did not match', async () => {
    const cardId = await freshCard('Probe Mismatch Refund')

    const { body } = await verifyWith(cardId, 'pay_card_mastercard_captured')
    expect(body.status).toBe('mismatched')
    expect(body.releaseState).toBe('refunded')
  })

  it('rejects a payment that was not made with a card', async () => {
    const cardId = await freshCard('Probe Upi')

    const { res, body } = await verifyWith(cardId, 'pay_upi_authorized')
    expect(res.status).toBe(422)
    expect(body.reason).toBe('not_a_card_payment')
  })

  it('rejects a forged signature and marks the attempt failed', async () => {
    const cardId = await freshCard('Probe Forged')
    const start = await json(
      await SELF.fetch(
        `${base}/v1/verifications`,
        as(token, { method: 'POST', body: JSON.stringify({ cardId }) }),
      ),
    )

    const res = await SELF.fetch(
      `${base}/v1/verifications/${start.verificationId}/confirm`,
      as(token, {
        method: 'POST',
        body: JSON.stringify({
          razorpay_payment_id: 'pay_card_visa_forged',
          razorpay_order_id: start.orderId,
          razorpay_signature: 'a'.repeat(64),
        }),
      }),
    )

    expect(res.status).toBe(400)
    expect((await json(res)).error.details[0]).toMatch(/signature did not verify/)

    const row = await env.DB.prepare(
      'SELECT status, failure_reason FROM card_verifications WHERE id = ?',
    )
      .bind(start.verificationId)
      .first<{ status: string; failure_reason: string }>()
    expect(row?.status).toBe('failed')
    expect(row?.failure_reason).toBe('signature_mismatch')
  })

  it('rejects a callback naming a different order', async () => {
    const cardId = await freshCard('Probe Wrong Order')
    const start = await json(
      await SELF.fetch(
        `${base}/v1/verifications`,
        as(token, { method: 'POST', body: JSON.stringify({ cardId }) }),
      ),
    )

    const res = await SELF.fetch(
      `${base}/v1/verifications/${start.verificationId}/confirm`,
      as(token, {
        method: 'POST',
        body: JSON.stringify({
          razorpay_payment_id: 'pay_card_visa_wrongorder',
          razorpay_order_id: 'order_someone_else',
          razorpay_signature: await sign('order_someone_else', 'pay_card_visa_wrongorder'),
        }),
      }),
    )

    expect(res.status).toBe(400)
    expect((await json(res)).error.details[0]).toMatch(/different order/)
  })

  it('cannot be confirmed twice', async () => {
    const cardId = await freshCard('Probe Twice')

    const { start } = await verifyWith(cardId, 'pay_card_visa_twice')

    const again = await SELF.fetch(
      `${base}/v1/verifications/${start.verificationId}/confirm`,
      as(token, {
        method: 'POST',
        body: JSON.stringify({
          razorpay_payment_id: 'pay_card_visa_twice',
          razorpay_order_id: start.orderId,
          razorpay_signature: await sign(start.orderId, 'pay_card_visa_twice'),
        }),
      }),
    )
    expect(again.status).toBe(409)
  })

  /**
   * The replay guard. Without the UNIQUE index on razorpay_payment_id, one
   * successful rupee would verify every card in the catalog.
   */
  it('refuses to reuse one payment for a second card', async () => {
    const bankId = (await json(await SELF.fetch(`${base}/v1/cards/${visaCard}`))).bank.id
    const make = async (name: string) => {
      const c = await json(
        await SELF.fetch(`${base}/v1/cards`, {
          method: 'POST',
          headers: ADMIN,
          body: JSON.stringify({
            bankId,
            name,
            country: 'IN',
            networks: [{ code: 'visa', bins: ['411111'] }],
          }),
        }),
      )
      await SELF.fetch(`${base}/v1/wallet/cards/${c.id}`, as(token, { method: 'PUT' }))
      return c.id
    }

    const first = await make('Probe Replay One')
    const second = await make('Probe Replay Two')

    const paymentId = 'pay_card_visa_replay'
    const one = await verifyWith(first, paymentId)
    expect(one.res.status).toBe(200)

    const two = await verifyWith(second, paymentId)
    expect(two.res.status).toBe(409)

    const wallet = await json(await SELF.fetch(`${base}/v1/wallet`, as(token)))
    expect(wallet.cards.find((c: any) => c.card.id === second).verificationStatus).not.toBe(
      'verified',
    )
  })

  it('will not let one person confirm another person\'s verification', async () => {
    const cardId = await freshCard('Probe Intruder')
    const start = await json(
      await SELF.fetch(
        `${base}/v1/verifications`,
        as(token, { method: 'POST', body: JSON.stringify({ cardId }) }),
      ),
    )

    const res = await SELF.fetch(
      `${base}/v1/verifications/${start.verificationId}/confirm`,
      as(otherToken, {
        method: 'POST',
        body: JSON.stringify({
          razorpay_payment_id: 'pay_card_rupay_intruder',
          razorpay_order_id: start.orderId,
          razorpay_signature: await sign(start.orderId, 'pay_card_rupay_intruder'),
        }),
      }),
    )
    expect(res.status).toBe(404)
  })

  it('refuses to start a second verification once a card is proved', async () => {
    const res = await SELF.fetch(
      `${base}/v1/verifications`,
      as(token, { method: 'POST', body: JSON.stringify({ cardId: visaCard }) }),
    )
    expect(res.status).toBe(409)
    expect((await json(res)).error.message).toMatch(/already verified/)
  })
})

/**
 * A verification is a fact about a person and a card, and it lives in
 * card_verifications. `wallet_cards.verification_status` is only that fact
 * reflected onto the row the screens read -- so dropping the row (removing the
 * card) must not lose the fact, and putting the row back must take it up again.
 *
 * Left to drift, the two disagree in the worst possible direction: the wallet
 * says "unverified" while `hasVerified` says "already verified", and the card
 * is stuck -- shown as unproved, and refused a fresh attempt.
 */
describe('a card removed from the wallet and added back', () => {
  const wallet = async (sessionToken = token) =>
    json(await SELF.fetch(`${base}/v1/wallet`, as(sessionToken)))

  const entryFor = async (cardId: string, sessionToken = token) =>
    (await wallet(sessionToken)).cards.find((c: any) => c.card.id === cardId)

  it('comes back verified, on the date it was actually proved', async () => {
    const cardId = await freshCard('Probe Re-add')
    expect((await verifyWith(cardId, 'pay_card_visa_readd')).res.status).toBe(200)

    const provedAt = (await entryFor(cardId)).verifiedAt
    expect(provedAt).not.toBeNull()

    await SELF.fetch(`${base}/v1/wallet/cards/${cardId}`, as(token, { method: 'DELETE' }))
    await SELF.fetch(`${base}/v1/wallet/cards/${cardId}`, as(token, { method: 'PUT' }))

    const entry = await entryFor(cardId)
    expect(entry.verificationStatus).toBe('verified')
    // The proof is dated when the rupee was paid, not when the row came back.
    expect(entry.verifiedAt).toBe(provedAt)
  })

  it('does not ask for the rupee a second time', async () => {
    const cardId = await freshCard('Probe Re-add Retry')
    await verifyWith(cardId, 'pay_card_visa_readdretry')

    await SELF.fetch(`${base}/v1/wallet/cards/${cardId}`, as(token, { method: 'DELETE' }))
    await SELF.fetch(`${base}/v1/wallet/cards/${cardId}`, as(token, { method: 'PUT' }))

    // The 409 is right -- the card *is* proved. What was wrong was a wallet row
    // that said otherwise, leaving the screen offering a Verify button that
    // could only ever fail.
    const res = await SELF.fetch(
      `${base}/v1/verifications`,
      as(token, { method: 'POST', body: JSON.stringify({ cardId }) }),
    )
    expect(res.status).toBe(409)
    expect((await entryFor(cardId)).verificationStatus).toBe('verified')
  })

  it('stays unverified when nothing ever proved it', async () => {
    const cardId = await freshCard('Probe Re-add Unproved')

    await SELF.fetch(`${base}/v1/wallet/cards/${cardId}`, as(token, { method: 'DELETE' }))
    await SELF.fetch(`${base}/v1/wallet/cards/${cardId}`, as(token, { method: 'PUT' }))

    const entry = await entryFor(cardId)
    expect(entry.verificationStatus).toBe('unverified')
    expect(entry.verifiedAt).toBeNull()
  })

  it('stays unverified when the only attempt was a mismatch', async () => {
    const cardId = await freshCard('Probe Re-add Mismatched')
    expect((await verifyWith(cardId, 'pay_card_mastercard_readd')).res.status).toBe(422)

    await SELF.fetch(`${base}/v1/wallet/cards/${cardId}`, as(token, { method: 'DELETE' }))
    await SELF.fetch(`${base}/v1/wallet/cards/${cardId}`, as(token, { method: 'PUT' }))

    expect((await entryFor(cardId)).verificationStatus).toBe('unverified')
  })

  it('comes back verified through the sign-in merge too', async () => {
    const cardId = await freshCard('Probe Re-add Merge')
    await verifyWith(cardId, 'pay_card_visa_readdmerge')

    await SELF.fetch(`${base}/v1/wallet/cards/${cardId}`, as(token, { method: 'DELETE' }))

    // What a browser that still had the card in localStorage would send.
    const merged = await json(
      await SELF.fetch(
        `${base}/v1/wallet/merge`,
        as(token, { method: 'POST', body: JSON.stringify({ cardIds: [cardId] }) }),
      ),
    )

    expect(merged.cards.find((c: any) => c.card.id === cardId).verificationStatus).toBe('verified')
  })

  it('cannot be talked out of a verification by a stale client', async () => {
    const cardId = await freshCard('Probe Stale Tab')
    await verifyWith(cardId, 'pay_card_visa_staletab')
    const provedAt = (await entryFor(cardId)).verifiedAt

    // A tab opened before the card was proved, still believing it has to run a
    // verification: it paints the row pending, fails on the 409, and writes
    // that back. Neither write may unpick a payment that already happened.
    for (const status of ['pending', 'failed', 'unverified']) {
      const res = await SELF.fetch(
        `${base}/v1/wallet/cards/${cardId}`,
        as(token, { method: 'PATCH', body: JSON.stringify({ status }) }),
      )
      expect(res.status).toBe(200)
    }

    const entry = await entryFor(cardId)
    expect(entry.verificationStatus).toBe('verified')
    expect(entry.verifiedAt).toBe(provedAt)
  })
})
