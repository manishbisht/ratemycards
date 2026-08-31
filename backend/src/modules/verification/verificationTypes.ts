import { generateId, idPattern } from '../../http/ids'

export const VERIFICATION_ID_PREFIX = 'ver'
export const VERIFICATION_ID_PATTERN = idPattern(VERIFICATION_ID_PREFIX)

export function generateVerificationId(): string {
  return generateId(VERIFICATION_ID_PREFIX)
}

export const VERIFICATION_STATUSES = ['created', 'verified', 'mismatched', 'failed'] as const
export type VerificationAttemptStatus = (typeof VERIFICATION_STATUSES)[number]

export const RELEASE_STATES = ['pending', 'voided', 'refunded'] as const
export type ReleaseState = (typeof RELEASE_STATES)[number]

/**
 * Razorpay reports a network as a display string. Mapped onto our codes rather
 * than compared loosely, so a rename on their side is a failed match we can see
 * in the logs instead of a silent pass.
 *
 * Keys are lowercased and stripped of spaces before lookup, so "American
 * Express", "american express" and "AmericanExpress" all land.
 */
const NETWORK_BY_RAZORPAY_NAME: Record<string, string> = {
  visa: 'visa',
  mastercard: 'mastercard',
  maestro: 'mastercard',
  rupay: 'rupay',
  americanexpress: 'amex',
  amex: 'amex',
  dinersclub: 'diners',
  diners: 'diners',
  discover: 'discover',
  jcb: 'jcb',
  unionpay: 'unionpay',
}

export function networkCodeFor(razorpayNetwork: string): string | null {
  const key = razorpayNetwork.toLowerCase().replace(/[^a-z]/g, '')
  return NETWORK_BY_RAZORPAY_NAME[key] ?? null
}

/**
 * What the browser needs to open Checkout. `keyId` comes from here rather than
 * a VITE_ variable so the API stays the single place that knows it, the way
 * `issuer` is derived rather than duplicated on the frontend.
 */
export type VerificationOrder = {
  verificationId: string
  keyId: string
  orderId: string
  amount: number
  currency: 'INR'
  /** Shown in the Checkout modal so the person knows what they are proving. */
  cardName: string
  issuer: string
  /**
   * Narrows the Checkout modal to this card's own plastic.
   *
   * `iins` is the BIN list; empty for the two thirds of the catalog with no
   * prefixes on file, in which case Checkout falls back to `networks` alone.
   * Neither is a security control -- this object is assembled in the browser
   * and can be edited there. The check that counts is in `confirm`.
   */
  allowed: {
    iins: string[]
    networks: string[]
  }
}

export type VerificationAttempt = {
  id: string
  userId: string
  cardId: string
  orderId: string
  paymentId: string | null
  amount: number
  status: VerificationAttemptStatus
  releaseState: ReleaseState
}

/** The confirm step's answer: what happened, and why if it went badly. */
export type VerificationResult = {
  verificationId: string
  status: VerificationAttemptStatus
  releaseState: ReleaseState
  card: {
    network: string | null
    last4: string | null
    type: string | null
    issuer: string | null
  }
  reason?: string
}
