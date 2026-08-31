import { isPlainObject } from '../../http/validators'
import { CARD_ID_PATTERN } from '../cards/cardTypes'

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/** Razorpay ids are opaque; only the shape is checked before they reach SQL. */
const RAZORPAY_ID = /^[A-Za-z0-9_]{6,64}$/
const HEX_SIGNATURE = /^[0-9a-fA-F]{64}$/

export function validateVerificationStart(body: unknown): Validated<{ cardId: string }> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }
  if (typeof body.cardId !== 'string' || !CARD_ID_PATTERN.test(body.cardId)) {
    return { ok: false, errors: ['cardId must be a valid card id.'] }
  }
  return { ok: true, value: { cardId: body.cardId } }
}

export type CheckoutCallback = {
  paymentId: string
  orderId: string
  signature: string
}

/**
 * The three fields Checkout hands back. Named as Razorpay sends them, snake_case
 * and all, because a client copying from their docs should not have to translate.
 *
 * The signature is length-checked here so a malformed one is a 400 rather than
 * reaching the HMAC compare -- which would reject it anyway, just less clearly.
 */
export function validateCheckoutCallback(body: unknown): Validated<CheckoutCallback> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  const errors: string[] = []
  const { razorpay_payment_id: paymentId, razorpay_order_id: orderId } = body
  const signature = body.razorpay_signature

  if (typeof paymentId !== 'string' || !RAZORPAY_ID.test(paymentId)) {
    errors.push('razorpay_payment_id is required.')
  }
  if (typeof orderId !== 'string' || !RAZORPAY_ID.test(orderId)) {
    errors.push('razorpay_order_id is required.')
  }
  if (typeof signature !== 'string' || !HEX_SIGNATURE.test(signature)) {
    errors.push('razorpay_signature is required and must be 64 hex characters.')
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    value: {
      paymentId: paymentId as string,
      orderId: orderId as string,
      signature: signature as string,
    },
  }
}
