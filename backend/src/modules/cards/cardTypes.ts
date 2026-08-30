import { generateId, idPattern } from '../../http/ids'
import type { Rating } from '../scoring/scoringTypes'
import type { VerificationStatus } from '../wallet/walletTypes'

export const CARD_ID_PREFIX = 'card'
export const CARD_ID_PATTERN = idPattern(CARD_ID_PREFIX)

export function generateCardId(): string {
  return generateId(CARD_ID_PREFIX)
}

/** The issuing bank, embedded in a card so a list needs no follow-up request. */
export type CardBank = {
  id: string
  name: string
}

/**
 * A signed-in caller's own state on a card. Absent entirely for anonymous
 * callers, so the public response shape is exactly what it always was.
 */
export type CardWallet = {
  inWallet: boolean
  verificationStatus: VerificationStatus
  /** ISO date, set only once the card is verified. */
  verifiedAt: string | null
}

/**
 * The public card. Deliberately carries no rating: the rubric, the per-criterion
 * scores, and the 0-10 rating derived from them are internal, and the API only
 * ever exposes them aggregated into a whole wallet's score.
 */
export type Card = {
  id: string
  name: string
  bank: CardBank
  /** Flat alias for the bank name, matching what the frontend renders. */
  issuer: string
  country: string
  /** Whole units of the card's local currency, not minor units. */
  joiningFee: number
  annualFee: number
  isActive: boolean
  /** Only present when the request carried a session token. */
  wallet?: CardWallet
}

/**
 * A card with its rating attached, for server-side scoring only. Never
 * serialised to a response -- `toPublicCard` is the one door out.
 */
export type RatedCard = Card & { rating: Rating }

export function toPublicCard(card: RatedCard): Card {
  const { rating: _rating, ...pub } = card
  return pub
}

export type CardInput = {
  bankId: string
  name: string
  country: string
  joiningFee: number
  annualFee: number
  isActive?: boolean
}

export type CardPatch = Partial<CardInput>

export type CardFilters = {
  q?: string
  bankId?: string
  country?: string
  maxAnnualFee?: number
  ids?: string[]
  includeInactive: boolean
  limit: number
  offset: number
}
