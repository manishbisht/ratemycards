import type { Tier } from './api'
import type { Card } from './cards'

export type DemoProfile = {
  handle: string
  /** The design's headline number, kept literal so `#u/arjun` matches it. */
  rating: number
  /** Literal too: the ladder lives in the API, and a mockup has nothing to ask. */
  tier: Tier
  verifiedCount: number
  summary: string
  cards: Card[]
}

/**
 * The example wallet from the design, behind `#u/arjun`. Its cards are literal
 * rather than fetched: this is a mockup of somebody else's profile, and until
 * public profiles are a real endpoint there is nothing to fetch them from.
 */
const DEMO_CARDS: Card[] = [
  { id: 'demo-cashback', name: 'Cashback', issuer: 'SBI', short: 'SBI\nCashback', joiningFee: 999, annualFee: 999, selectable: true },
  { id: 'demo-atlas', name: 'Atlas', issuer: 'Axis', short: 'Axis\nAtlas', joiningFee: 5000, annualFee: 5000, selectable: true },
  { id: 'demo-amexplat', name: 'Platinum Charge Card', issuer: 'American Express', short: 'Amex\nPlatinum', joiningFee: 66000, annualFee: 66000, selectable: true },
  { id: 'demo-infinia', name: 'Infinia Metal', issuer: 'HDFC', short: 'HDFC\nInfinia Metal', joiningFee: 12500, annualFee: 12500, selectable: true },
]

export const DEMO_PROFILES: Record<string, DemoProfile> = {
  arjun: {
    handle: 'arjun',
    rating: 2447,
    tier: { min: 2200, name: 'Master', color: '#FB923C' },
    verifiedCount: 4,
    summary: 'Serious travel stack. One cashback card away from complete.',
    cards: DEMO_CARDS,
  },
}

export function demoProfile(handle: string): DemoProfile | undefined {
  return DEMO_PROFILES[handle]
}
