import { Hono } from 'hono'
import { requireUser } from '../../http/clerkAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import type { AppEnv, AuthUser } from '../../env'
import { getCard, listCardNetworks } from '../cards/queries'
import { listWalletRows, setVerificationStatus } from '../wallet/queries'
import {
  MIN_AMOUNT,
  createOrder,
  fetchPayment,
  fetchPaymentCard,
  isValidCheckoutSignature,
  razorpayKeys,
  refundPayment,
} from './razorpay'
import type { RazorpayCard, RazorpayKeys } from './razorpay'
import {
  createAttempt,
  getAttempt,
  hasVerified,
  recordRelease,
  settleAttempt,
} from './queries'
import { networkCodeFor } from './verificationTypes'
import type { ReleaseState, VerificationOrder, VerificationResult } from './verificationTypes'
import { validateCheckoutCallback, validateVerificationStart } from './validate'

/**
 * Proving someone holds a card, by charging one rupee to it and giving it back.
 *
 * The flow is two calls with the Razorpay Checkout modal in between:
 *
 *   POST /v1/verifications            -> order + the BINs to narrow Checkout to
 *   (browser opens Checkout, person pays with their real card)
 *   POST /v1/verifications/:id/confirm -> signature checked, card matched, money released
 *
 * The BIN list handed out by the first call narrows what Checkout *offers*. It
 * is not the check. The object it lands in is assembled in the browser and can
 * be edited there, so `confirm` re-derives everything from Razorpay's own view
 * of the payment and trusts nothing the client says beyond the three callback
 * fields -- whose signature it verifies.
 */
export const verificationRoutes = new Hono<AppEnv>()

function callerId(user: AuthUser | undefined): string {
  if (!user) throw ApiError.unauthorized('A valid session token is required.')
  return user.id
}

verificationRoutes.post('/', requireUser, async (c) => {
  const result = validateVerificationStart(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const { cardId } = result.value
  const userId = callerId(c.get('user'))
  const keys = razorpayKeys(c.env)

  const card = await getCard(c.env.DB, cardId)
  if (!card) throw ApiError.notFound(`Card '${cardId}'`)

  // Verifying a card you do not claim to hold is meaningless, and the UI only
  // offers it for cards already in the wallet.
  const held = await listWalletRows(c.env.DB, userId)
  if (!held.some((row) => row.card_id === cardId)) {
    throw ApiError.validation(['Add the card to your wallet before verifying it.'])
  }

  if (await hasVerified(c.env.DB, userId, cardId)) {
    throw ApiError.conflict(`'${card.name}' is already verified.`)
  }

  const networks = await listCardNetworks(c.env.DB, cardId)
  if (networks.length === 0) {
    // Nothing to narrow Checkout to and nothing to match against afterwards, so
    // there is no honest way to verify this card.
    throw ApiError.validation([`No payment networks are on file for '${card.name}'.`])
  }

  const attemptId = crypto.randomUUID().replaceAll('-', '')
  const order = await createOrder(keys, {
    amount: MIN_AMOUNT,
    // Razorpay caps receipts at 40 characters.
    receipt: `ver_${attemptId}`.slice(0, 40),
    notes: { cardId, userId, purpose: 'card_verification' },
  })

  const attempt = await createAttempt(c.env.DB, {
    userId,
    cardId,
    orderId: order.id,
    amount: order.amount,
  })

  // 'pending' until the callback lands, so the UI can show it in flight.
  await setVerificationStatus(c.env.DB, userId, cardId, 'pending')

  const body: VerificationOrder = {
    verificationId: attempt.id,
    keyId: keys.keyId,
    orderId: order.id,
    amount: order.amount,
    currency: 'INR',
    cardName: card.name,
    issuer: card.issuer,
    allowed: {
      iins: networks.flatMap((n) => n.bins),
      networks: networks.map((n) => n.network),
    },
  }

  return c.json(body, 201)
})

verificationRoutes.post('/:id/confirm', requireUser, async (c) => {
  const result = validateCheckoutCallback(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const callback = result.value
  const userId = callerId(c.get('user'))
  const keys = razorpayKeys(c.env)

  const attempt = await getAttempt(c.env.DB, c.req.param('id'), userId)
  if (!attempt) throw ApiError.notFound(`Verification '${c.req.param('id')}'`)
  if (attempt.status !== 'created') {
    throw ApiError.conflict('That verification has already been settled.')
  }

  // The order id is ours, not the client's, so a callback naming a different
  // order is either confused or hostile.
  if (callback.orderId !== attempt.orderId) {
    await settleAttempt(c.env.DB, attempt.id, {
      paymentId: callback.paymentId,
      status: 'failed',
      reason: 'order_mismatch',
    })
    throw ApiError.validation(['That payment belongs to a different order.'])
  }

  const signed = await isValidCheckoutSignature({
    keySecret: keys.keySecret,
    orderId: callback.orderId,
    paymentId: callback.paymentId,
    signature: callback.signature,
  })

  if (!signed) {
    await settleAttempt(c.env.DB, attempt.id, {
      paymentId: callback.paymentId,
      status: 'failed',
      reason: 'signature_mismatch',
    })
    await setVerificationStatus(c.env.DB, userId, attempt.cardId, 'failed')
    throw ApiError.validation(['The payment signature did not verify.'])
  }

  // Everything from here is Razorpay's account of what happened, not the
  // client's. This is the part that decides.
  const payment = await fetchPayment(keys, callback.paymentId)

  // Belt and braces over the signature: Razorpay's own record of which order
  // the payment settled against has to agree with ours too.
  if (payment.order_id !== null && payment.order_id !== attempt.orderId) {
    await settleAttempt(c.env.DB, attempt.id, {
      paymentId: payment.id,
      status: 'failed',
      reason: 'order_mismatch_upstream',
    })
    throw ApiError.validation(['That payment settled against a different order.'])
  }

  const card = payment.method === 'card' ? await fetchPaymentCard(keys, payment.id) : null

  const verdict = await judge(c.env.DB, attempt.cardId, payment.method, card)

  await settleAttempt(c.env.DB, attempt.id, {
    paymentId: payment.id,
    status: verdict.ok ? 'verified' : 'mismatched',
    card,
    reason: verdict.ok ? null : verdict.reason,
  })

  await setVerificationStatus(
    c.env.DB,
    userId,
    attempt.cardId,
    verdict.ok ? 'verified' : 'failed',
  )

  // The rupee goes back either way: a mismatch is not a reason to keep it.
  const releaseState = await release(keys, payment.id, payment.status)
  await recordRelease(c.env.DB, attempt.id, releaseState)

  const body: VerificationResult = {
    verificationId: attempt.id,
    status: verdict.ok ? 'verified' : 'mismatched',
    releaseState,
    card: {
      network: card?.network ?? null,
      last4: card?.last4 ?? null,
      type: card?.type ?? null,
      issuer: card?.issuer ?? null,
    },
    ...(verdict.ok ? {} : { reason: verdict.reason }),
  }

  return c.json(body, verdict.ok ? 200 : 422)
})

/**
 * Does the card that actually paid belong to the card being claimed?
 *
 * Only the network is matched, because the network is all Razorpay and our own
 * data can both speak to. There is no BIN in the payment's card entity, and a
 * BIN would only have resolved issuer + network + tier anyway. `issuer` is
 * recorded but not enforced: Razorpay reports 4-character bank codes (`UTIB`
 * for Axis) and mapping those onto the catalog's twelve bank names is a table
 * that does not exist yet -- enforcing it on a guess would reject real cards.
 */
async function judge(
  db: D1Database,
  cardId: string,
  method: string,
  card: RazorpayCard | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (method !== 'card' || !card) return { ok: false, reason: 'not_a_card_payment' }

  const code = networkCodeFor(card.network)
  if (!code) return { ok: false, reason: `unrecognised_network:${card.network}` }

  const networks = await listCardNetworks(db, cardId)
  if (!networks.some((n) => n.network === code)) {
    return { ok: false, reason: `network_mismatch:${code}` }
  }

  return { ok: true }
}

/**
 * Gives the rupee back, by whichever route the payment's state allows.
 *
 * An authorised-but-uncaptured payment cannot be refunded over the API -- there
 * is nothing to refund yet -- and Razorpay voids it within a few days on its
 * own. That is the cheap path and the one `payment_capture: 0` aims for. If the
 * account is configured to auto-capture, the payment arrives already captured
 * and the only way back is a refund, whose fee is not reversed.
 *
 * Never throws: the verification has already been decided and recorded by this
 * point, and a failed refund must not turn a good verification into a 500.
 */
async function release(
  keys: RazorpayKeys,
  paymentId: string,
  status: string,
): Promise<ReleaseState> {
  if (status !== 'captured') return 'voided'

  try {
    await refundPayment(keys, paymentId)
    return 'refunded'
  } catch (err) {
    console.error(`Could not refund verification payment '${paymentId}'`, err)
    return 'pending'
  }
}
