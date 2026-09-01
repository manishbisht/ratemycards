import type { StoredWallet, Tier } from '../wallet/walletTypes'

/**
 * What the world may see of somebody's wallet.
 *
 * This type and the function below it are the security boundary for the only
 * unauthenticated read of a person's data in the API, so both are deliberately
 * one short thing to review. Nothing about the *person* appears: no email, no
 * name, no avatar, no id -- ours or Clerk's. The handle is the identity, and it
 * is the one they chose to publish.
 */
export type PublicProfileCard = {
  id: string
  name: string
  issuer: string
  bank: { id: string; name: string }
}

export type PublicProfile = {
  handle: string
  score: number
  maxScore: number
  tier: Tier
  cardCount: number
  cards: PublicProfileCard[]
}

/**
 * Built by naming each field rather than spreading and deleting: a field added
 * to the card or the wallet later cannot leak through a projection that has to
 * be edited to carry it.
 */
export function toPublicProfile(handle: string, wallet: StoredWallet): PublicProfile {
  return {
    handle,
    score: wallet.score.score,
    maxScore: wallet.score.maxScore,
    tier: wallet.score.tier,
    cardCount: wallet.score.cardCount,
    cards: wallet.cards.map((entry) => ({
      id: entry.card.id,
      name: entry.card.name,
      issuer: entry.card.issuer,
      bank: { id: entry.card.bank.id, name: entry.card.bank.name },
    })),
  }
}
