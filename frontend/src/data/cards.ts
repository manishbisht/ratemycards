/**
 * The card as this app uses it. The catalog itself lives in the API -- there is
 * no local copy any more, so nothing here can drift out of date.
 *
 * A card carries no rating: the API does not publish one. Ratings exist only
 * aggregated over a whole wallet, and only once the user asks to see it.
 */

export type CardId = string

export type Card = {
  id: CardId
  name: string
  /** The issuing bank, rendered as the row subtitle. */
  issuer: string
  /** Two-line label for the deck tiles. */
  short: string
  joiningFee: number
  annualFee: number
  /** True when the card has at least one BIN prefix on file, i.e. can be verified. */
  selectable: boolean
}

/** Card ids are minted by the API; anything else is stale local state. */
export const CARD_ID_PATTERN = /^card_[0-9a-f]{32}$/

export function isCardId(value: unknown): value is CardId {
  return typeof value === 'string' && CARD_ID_PATTERN.test(value)
}
