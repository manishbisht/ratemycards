import type { VerificationStatus } from '../state/walletTypes'

/** Row labels and colours, transcribed from the design's LABEL/COLOR maps. */
export const STATUS_LABEL: Record<VerificationStatus, string> = {
  unverified: 'Unverified',
  pending: 'Verifying',
  verified: 'Verified',
  failed: 'Not verified',
}

export const STATUS_COLOR: Record<VerificationStatus, string> = {
  unverified: 'rgba(255,255,255,0.4)',
  pending: '#22D3EE',
  verified: '#34D399',
  failed: '#F87171',
}

/**
 * Why a card with no BIN prefixes on file shows 'Can't verify'.
 *
 * Not part of `verifyNote`, because it is not a verification status: the card
 * is `unverified` like any other, and what stops it is a gap in the catalog
 * rather than anything this wallet has or has not done.
 */
export const BLOCKED_NOTE =
  'No card numbers are on file for this card yet, so nothing here can check it.'

export function verifyNote(status: VerificationStatus, verifiedAt?: string): string {
  switch (status) {
    case 'pending':
      return 'A ₹1 authorisation has been sent. Approve it in your banking app — we refund it immediately.'
    case 'verified': {
      const date = verifiedAt ? new Date(verifiedAt) : new Date()
      const stamp = date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
      return `Verified on ${stamp}. Counting towards your rating.`
    }
    case 'failed':
      return 'The authorisation was declined. Check the card is active and try again.'
    case 'unverified':
      return ''
  }
}
