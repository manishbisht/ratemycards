import { isPlainObject } from '../../http/validators'
import { isVerificationStatus } from './walletTypes'
import type { VerificationStatus } from './walletTypes'
import { CARD_ID_PATTERN } from '../cards/cardTypes'
import { MAX_IDS } from '../../http/params'

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/**
 * A wallet is a set of card ids. Duplicates are collapsed rather than rejected
 * -- a client resending the same card twice means one card, not an error.
 */
export function validateCardIds(body: unknown): Validated<string[]> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }
  if (!Array.isArray(body.cardIds)) {
    return { ok: false, errors: ['cardIds is required and must be an array.'] }
  }
  if (body.cardIds.length > MAX_IDS) {
    return { ok: false, errors: [`A wallet may hold at most ${MAX_IDS} cards.`] }
  }

  const errors: string[] = []
  const ids: string[] = []
  const seen = new Set<string>()

  body.cardIds.forEach((raw: unknown, index: number) => {
    if (typeof raw !== 'string' || !CARD_ID_PATTERN.test(raw)) {
      errors.push(`cardIds[${index}] must be a valid card id.`)
      return
    }
    if (seen.has(raw)) return
    seen.add(raw)
    ids.push(raw)
  })

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: ids }
}

/**
 * The body of a verification-status write. Only the status is accepted: the
 * timestamp that goes with it is the server's to decide, so a client cannot
 * backdate a verification.
 *
 * 'verified' is NOT accepted here, and that is the point. It is earned by
 * POST /v1/verifications/:id/confirm, which checks a real Razorpay payment
 * against the card being claimed. If this endpoint took the client's word for it
 * -- as it did before that flow existed -- the whole 1-rupee check would be
 * bypassable with a single curl, and every rating built on it would be fiction.
 *
 * The other three stay writable: they are the client reporting what it saw
 * (a dismissed modal, a decline), and none of them grants anything.
 */
export function validateVerificationStatus(body: unknown): Validated<VerificationStatus> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }
  if (!isVerificationStatus(body.status)) {
    return {
      ok: false,
      errors: ['status must be one of: unverified, pending, verified, failed.'],
    }
  }
  if (body.status === 'verified') {
    return {
      ok: false,
      errors: ['A card can only become verified by completing a card verification.'],
    }
  }

  return { ok: true, value: body.status }
}

/** A single card id from a path segment, checked before it reaches SQL. */
export function validateCardIdParam(raw: string): Validated<string> {
  return CARD_ID_PATTERN.test(raw)
    ? { ok: true, value: raw }
    : { ok: false, errors: ['The card id in the path is not a valid card id.'] }
}
