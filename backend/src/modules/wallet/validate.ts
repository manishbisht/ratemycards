import { isPlainObject } from '../../http/validators'
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
