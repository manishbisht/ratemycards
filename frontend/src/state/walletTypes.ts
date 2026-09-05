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
  /**
   * Whether the wallet in this browser has been reconciled with the server for
   * the current session. Guards the merge from running twice, and tells the
   * write-through listeners that the server is now the one to tell.
   */
  synced: boolean
  /** The handle the user has claimed, once they have claimed one. */
  handle: string | null
  /**
   * Whether `handle` is an answer rather than an absence of one.
   *
   * `handle: null` on its own is ambiguous -- it is both "the server has not
   * been asked yet" and "asked, and this account has no handle" -- and the two
   * route a returning user to different screens. Anything that decides on the
   * handle has to wait for this.
   */
  handleSynced: boolean
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
