import type { StoredWallet } from '../data/api'
import type { CardId } from '../data/cards'
import type { VerificationStatus } from '../state/walletTypes'

/**
 * The server models a wallet as a list of cards each carrying its own state;
 * Redux models it as a list of ids plus two lookup maps, because that is what
 * the screens read. This is the one place the two shapes meet.
 */
export function toWalletState(wallet: StoredWallet): {
  picked: CardId[]
  vstatus: Record<CardId, VerificationStatus>
  verifiedAt: Record<CardId, string>
} {
  const picked: CardId[] = []
  const vstatus: Record<CardId, VerificationStatus> = {}
  const verifiedAt: Record<CardId, string> = {}

  for (const entry of wallet.cards) {
    picked.push(entry.card.id)
    vstatus[entry.card.id] = entry.verificationStatus
    if (entry.verifiedAt) verifiedAt[entry.card.id] = entry.verifiedAt
  }

  return { picked, vstatus, verifiedAt }
}
