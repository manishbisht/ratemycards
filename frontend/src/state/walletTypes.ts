import type { CardId } from '../data/cards'

export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'failed'

export type User = {
  name: string
  email: string
}

export type WalletState = {
  picked: CardId[]
  vstatus: Record<CardId, VerificationStatus>
  user: User | null
  /** The handle the user has claimed, once they have claimed one. */
  handle: string | null
  /** ISO dates, so the verify note can name a real day. */
  verifiedAt: Record<CardId, string>
}

export type WalletAction =
  | { type: 'toggleCard'; id: CardId }
  | { type: 'setStatus'; id: CardId; status: VerificationStatus; at?: string }
  | { type: 'signIn'; user: User }
  | { type: 'signOut' }
  | { type: 'claimHandle'; handle: string }
  | { type: 'reset' }
