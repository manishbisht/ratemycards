/**
 * The wallet score itself is computed by the API (`POST /v1/wallet/preview`),
 * so there is deliberately no formula here -- one implementation, no drift.
 * What is left is the copy derived from a wallet's shape.
 */

/** "1 of 2 verified · 1 not counted" */
export function verifyLine(chosenCount: number, verifiedCount: number): string {
  if (chosenCount === 0) return 'Add cards to begin'
  const unverified = chosenCount - verifiedCount
  const base = `${verifiedCount} of ${chosenCount} verified`
  return unverified === 0 ? base : `${base} · ${unverified} not counted`
}

/** The picker's button flips to "Reveal" only once nothing is left to verify. */
export function primaryCta(chosenCount: number, verifiedCount: number): string {
  return verifiedCount > 0 && verifiedCount === chosenCount ? 'Reveal' : 'Verify cards'
}

/**
 * Before sign-in nothing has been verified yet, so the picker counts cards
 * instead of verifications and the rating it shows is provisional.
 */
export function pickedLine(chosenCount: number): string {
  if (chosenCount === 0) return 'Add cards to begin'
  return `${chosenCount} ${chosenCount === 1 ? 'card' : 'cards'} added`
}

/**
 * The one-line read on the reveal and profile screens.
 *
 * The design ships a single hand-written example ("Serious travel stack. One
 * cashback card away from complete."), so these variants are derived copy, not
 * transcribed — they follow its shape but are ours to rewrite. They key off the
 * wallet's own score, which is the only quality signal the client is given.
 */
export function summaryFor(score: number, cardCount: number): string {
  if (cardCount === 0) return 'Add a card to get your first rating.'
  if (score >= 2600) return 'A formidable wallet. Very little left to add.'
  if (score >= 2200) return 'A serious stack, with the breadth to back it up.'
  if (score >= 1800) return 'Strong anchors. A wider spread would push you higher.'
  if (score >= 1400) return 'A solid wallet. A premium card would move you up a tier.'
  if (score >= 1000) return 'A practical start. Adding a card or two climbs fastest.'
  return 'An entry-level wallet. Plenty of room to climb.'
}
