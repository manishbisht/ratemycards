import { timingSafeEqual } from 'hono/utils/buffer'
import { ApiError } from '../../http/errors'

/**
 * The Razorpay REST calls this module needs, over `fetch`.
 *
 * Deliberately not the `razorpay` npm SDK: it is written against Node's `https`
 * and `crypto`, and everything here is three JSON calls plus one HMAC that Web
 * Crypto already does. The SDK would be a dependency and a workerd compat risk
 * bought for nothing.
 */

const API = 'https://api.razorpay.com/v1'

/** Paise. Razorpay enforces this floor server-side; we mirror it for a good 400. */
export const MIN_AMOUNT = 100

export type RazorpayKeys = { keyId: string; keySecret: string }

/** Reads the keys, failing closed the way adminAuth and clerkAuth do. */
export function razorpayKeys(env: Env): RazorpayKeys {
  const keyId = env.RAZORPAY_KEY_ID
  const keySecret = env.RAZORPAY_KEY_SECRET
  if (!keyId || !keySecret) {
    throw ApiError.unauthorized('Card verification is not configured on this deployment.')
  }
  return { keyId, keySecret }
}

function authHeader({ keyId, keySecret }: RazorpayKeys): string {
  return `Basic ${btoa(`${keyId}:${keySecret}`)}`
}

/**
 * Razorpay answers errors as `{ error: { code, description, ... } }` with a 4xx.
 * A 401 from them means our own keys are wrong, which is our problem and not the
 * caller's -- so it surfaces as a 500 rather than passing their 401 through and
 * telling a signed-in user to sign in again.
 */
async function call<T>(keys: RazorpayKeys, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(keys),
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  const body = (await res.json().catch(() => null)) as { error?: { description?: string } } | null

  if (!res.ok) {
    const detail = body?.error?.description ?? `HTTP ${res.status}`
    if (res.status === 401 || res.status === 403) {
      console.error('Razorpay rejected our credentials', detail)
      throw new Error(`Razorpay auth failed: ${detail}`)
    }
    console.error(`Razorpay ${path} failed`, res.status, detail)
    throw new Error(`Razorpay ${path} failed: ${detail}`)
  }

  return body as T
}

export type RazorpayOrder = { id: string; amount: number; currency: string; status: string }

/**
 * `payment_capture: 0` is the whole cost argument: the rupee is authorised and
 * never captured, Razorpay voids it within a few days, and an uncaptured
 * payment attracts no MDR. An account configured to auto-capture overrides
 * this, which is why the release step checks the payment's real status instead
 * of assuming.
 */
export async function createOrder(
  keys: RazorpayKeys,
  input: { amount: number; receipt: string; notes?: Record<string, string> },
): Promise<RazorpayOrder> {
  return call<RazorpayOrder>(keys, '/orders', {
    method: 'POST',
    body: JSON.stringify({
      amount: input.amount,
      currency: 'INR',
      receipt: input.receipt,
      payment_capture: 0,
      notes: input.notes ?? {},
    }),
  })
}

export type RazorpayPayment = {
  id: string
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'
  method: string
  order_id: string | null
  amount: number
  error_description?: string | null
}

export async function fetchPayment(
  keys: RazorpayKeys,
  paymentId: string,
): Promise<RazorpayPayment> {
  return call<RazorpayPayment>(keys, `/payments/${encodeURIComponent(paymentId)}`)
}

/**
 * What Razorpay will tell us about the card that was actually presented.
 *
 * There is no `iin` here, and that is not an omission on our side: the card
 * entity carries last4, network, type and issuer and nothing more. So the BIN
 * list we hand Checkout can narrow what a person is *offered*, but the check
 * that a card is really theirs can only be made at issuer/network/type
 * resolution. See the header of migration 0011.
 */
export type RazorpayCard = {
  id: string
  last4: string
  network: string
  type: string
  issuer: string | null
  international: boolean
}

export async function fetchPaymentCard(
  keys: RazorpayKeys,
  paymentId: string,
): Promise<RazorpayCard> {
  return call<RazorpayCard>(keys, `/payments/${encodeURIComponent(paymentId)}/card`)
}

/** Refunds a captured payment. Uncaptured ones cannot be refunded -- they void. */
export async function refundPayment(keys: RazorpayKeys, paymentId: string): Promise<void> {
  await call(keys, `/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    body: JSON.stringify({ speed: 'optimum', notes: { reason: 'card_verification' } }),
  })
}

/**
 * Verifies the Checkout callback signature: HMAC-SHA256 of
 * `<order_id>|<payment_id>` keyed with the key secret, hex encoded.
 *
 * This is what makes the callback trustworthy at all. Without it a client could
 * POST any order/payment pair and claim a verification, because the ids
 * themselves are not secret -- the browser is told both.
 */
export async function isValidCheckoutSignature(input: {
  keySecret: string
  orderId: string
  paymentId: string
  signature: string
}): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.keySecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${input.orderId}|${input.paymentId}`),
  )

  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')

  // Delegated rather than hand-rolled, the same call adminAuth leans on.
  return timingSafeEqual(expected, input.signature.trim().toLowerCase())
}
