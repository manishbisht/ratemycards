import type { Card, RatedCard } from '../cards/cardTypes'

/**
 * Wallet scoring: how a set of cards becomes one rating on the 0-3000 ladder.
 *
 * This is the ONLY implementation of the formula. The frontend used to carry a
 * copy in src/data/scoring.ts; it now reads the score off this endpoint so the
 * two cannot drift.
 */

export const MAX_SCORE = 3000
const BASE = 620
const MULTI_CARD_BONUS = 60

/**
 * A card contributes its 0-10 rating scaled to the 0-500 band the ladder was
 * built around, so an 8.8-rated card is worth 440.
 */
const RATING_TO_WEIGHT = 50

export function cardWeight(rating: number | null): number {
  return rating === null ? 0 : Math.round(rating * RATING_TO_WEIGHT)
}

export type Tier = {
  /** Inclusive lower bound. */
  min: number
  name: string
  color: string
}

/** Highest first, so the first match wins. */
export const TIERS: Tier[] = [
  { min: 2600, name: 'Grandmaster', color: '#F87171' },
  { min: 2200, name: 'Master', color: '#FB923C' },
  { min: 1800, name: 'Expert', color: '#A78BFA' },
  { min: 1400, name: 'Specialist', color: '#60A5FA' },
  { min: 1000, name: 'Optimiser', color: '#22D3EE' },
  { min: 0, name: 'Beginner', color: '#34D399' },
]

export function tierFor(score: number): Tier {
  return TIERS.find((tier) => score >= tier.min) ?? TIERS[TIERS.length - 1]
}

/**
 * Only the aggregate leaves the server. A per-card breakdown would expose the
 * same ratings the card endpoints deliberately withhold -- one card's weight is
 * its rating times a constant.
 */
export type WalletScore = {
  score: number
  maxScore: number
  tier: Tier
  cardCount: number
  /** Requested ids with no matching card -- lets a client prune stale state. */
  unknownIds: string[]
}

export function scoreWallet(cards: RatedCard[], requestedIds: string[]): WalletScore {
  const found = new Set(cards.map((card) => card.id))
  const weights = cards.map((card) => cardWeight(card.rating.score))

  // An empty wallet scores nothing rather than scoring the base.
  const score =
    weights.length === 0
      ? 0
      : Math.min(
          MAX_SCORE,
          BASE +
            weights.reduce((sum, weight) => sum + weight, 0) +
            (weights.length - 1) * MULTI_CARD_BONUS,
        )

  return {
    score,
    maxScore: MAX_SCORE,
    tier: tierFor(score),
    cardCount: cards.length,
    unknownIds: requestedIds.filter((id) => !found.has(id)),
  }
}

/**
 * How far along a card's ₹1-authorisation check is. Mirrors VerificationStatus
 * in the frontend's state/walletTypes.ts and the CHECK constraint in
 * 0008_create_wallet_cards.sql -- change one, change all three.
 */
export const VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'failed'] as const

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export function isVerificationStatus(value: unknown): value is VerificationStatus {
  return (
    typeof value === 'string' &&
    (VERIFICATION_STATUSES as readonly string[]).includes(value)
  )
}

/** One card in a stored wallet: the public card plus this holder's state on it. */
export type WalletCard = {
  card: Card
  verificationStatus: VerificationStatus
  /** ISO date, set only once the card is verified. */
  verifiedAt: string | null
}

/**
 * A stored wallet. The score is the same aggregate /preview returns, computed
 * over the held cards so a client never has to ask twice.
 */
export type StoredWallet = {
  cards: WalletCard[]
  score: WalletScore
}
