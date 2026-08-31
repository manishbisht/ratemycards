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
      body: JSON.stringify({ bankId, name, country: 'IN', networks }),
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
          body: JSON.stringify({ bankId, name, country: 'IN', ...(networks ? { networks } : {}) }),
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

  it('hands back an empty BIN list when the card has no prefixes on file', async () => {
    const body = await json(
      await SELF.fetch(
        `${base}/v1/verifications`,
        as(token, { method: 'POST', body: JSON.stringify({ cardId: rupayCard }) }),
      ),
    )
    expect(body.allowed.iins).toEqual([])
    expect(body.allowed.networks).toEqual(['rupay'])
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
    const { body } = await verifyWith(rupayCard, 'pay_card_rupay_authorized')
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
          body: JSON.stringify({ bankId, name, country: 'IN', networks: ['visa'] }),
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
