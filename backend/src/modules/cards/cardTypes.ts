import { generateId, idPattern } from '../../http/ids'
import type { Rating } from '../scoring/scoringTypes'
import type { VerificationStatus } from '../wallet/walletTypes'

export const CARD_ID_PREFIX = 'card'
export const CARD_ID_PATTERN = idPattern(CARD_ID_PREFIX)

export function generateCardId(): string {
  return generateId(CARD_ID_PREFIX)
}

/**
 * What kind of card this is. Mirrors the CHECK constraint in migration 0012 --
 * change one, change the other.
 *
 * Credit is the default and the whole of the launch catalog. The others exist
 * because the column may as well accept them: SQLite cannot widen a CHECK
 * without rebuilding the table, so the headroom is free now and expensive
 * later.
 */
export const CARD_TYPES = ['credit', 'debit', 'charge', 'prepaid'] as const

export type CardType = (typeof CARD_TYPES)[number]

export function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && (CARD_TYPES as readonly string[]).includes(value)
}

/**
 * One network a card runs on, with the BIN prefixes that network issues it
 * under. Internal: never serialised onto a card. `listCardNetworks` builds it
 * for the verification flow, which needs the prefixes to narrow Checkout.
 *
 * `network` is a code ('visa'), not an id -- ids do not leave the server.
 *
 * `bins` is a SUPERSET of the product's own prefixes, and often empty -- a
 * 6-digit BIN identifies issuer + network + tier, not an individual product.
 */
export type CardNetwork = {
  network: string
  /** 6- or 8-digit IIN prefixes, ascending. Empty when none is on file. */
  bins: string[]
}

/**
 * One network a card is issued on, as an admin writes it: the network's code
 * and the BIN prefixes to record under it.
 *
 * `bins` may be empty or absent. That is a real state -- the card runs on the
 * network but no prefix is on file -- and it is what makes the card
 * unselectable, because nothing can verify it.
 */
export type CardNetworkInput = {
  code: string
  bins: string[]
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
 *
 * It carries no networks either. Which networks a card runs on, and the BIN
 * prefixes behind each, are tracked in `card_networks` / `card_bins` but not
 * published on the card: the UI does not show them, and a card verification
 * that checks a BIN cannot be worth anything if the list of accepted BINs is
 * readable from the catalog. They get their own endpoint instead --
 * `GET /v1/cards/:id/networks`, which is admin-only on the read as well as the
 * write.
 */
export type Card = {
  id: string
  name: string
  bank: CardBank
  /** Flat alias for the bank name, matching what the frontend renders. */
  issuer: string
  country: string
  type: CardType
  /** Whole units of the card's local currency, not minor units. */
  joiningFee: number
  annualFee: number
  isActive: boolean
  /**
   * True when the card has at least one BIN prefix on file. This is what the
   * picker filters on to decide whether a card can be offered for
   * verification -- it exposes no prefix, only whether any exist.
   */
  selectable: boolean
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
  /** 'credit' unless an admin said otherwise. */
  type?: CardType
  /**
   * Replaces the card's whole network *and* BIN set rather than merging into
   * it, the same contract as PUT /v1/cards/:id/scores. Omitted leaves both
   * untouched; `[]` clears both, which is how an admin walks back a card they
   * got wrong.
   */
  networks?: CardNetworkInput[]
}

export type CardPatch = Partial<CardInput>

export type CardFilters = {
  q?: string
  bankId?: string
  network?: string
  country?: string
  maxAnnualFee?: number
  ids?: string[]
  includeInactive: boolean
  /**
   * Lets a caller see cards with no BIN prefixes, which browse and search hide.
   * Required rather than optional so every call site states its intent: getting
   * this wrong takes cards out of people's wallets.
   */
  includeUnselectable: boolean
  limit: number
  offset: number
}
