/**
 * The wallet score itself is computed by the API (`POST /v1/wallet/preview`),
 * so there is deliberately no formula here -- one implementation, no drift.
 * What is left is the copy derived from a wallet's shape.
 */

/**
 * "1 of 3 verified · 1 not counted · 1 can’t be verified yet"
 *
 * `blockedCount` is how many of the chosen cards have no BIN prefixes on file.
 * Nothing the person does can verify those, so they are called out separately
 * rather than folded into "not counted", which reads like something they still
 * have to go and do.
 */
export function verifyLine(chosenCount: number, verifiedCount: number, blockedCount = 0): string {
  if (chosenCount === 0) return 'Add cards to begin'

  const parts = [`${verifiedCount} of ${chosenCount} verified`]
  const pending = chosenCount - verifiedCount - blockedCount
  if (pending > 0) parts.push(`${pending} not counted`)
  if (blockedCount > 0) parts.push(`${blockedCount} can’t be verified yet`)

  return parts.join(' · ')
}

/**
 * The picker's button flips to "Reveal" only once nothing is left to verify.
 *
 * A card with no BIN prefixes on file cannot be verified BY ANYBODY, so it is
 * excluded from the target rather than counted against it. Without that, a
 * wallet holding one would sit on "Verify cards" for ever with nothing the
 * person could do about it -- which is exactly what happens now that the picker
 * offers those cards instead of hiding them.
 */
export function primaryCta(chosenCount: number, verifiedCount: number, blockedCount = 0): string {
  const verifiable = chosenCount - blockedCount
  return verifiedCount > 0 && verifiedCount === verifiable ? 'Reveal' : 'Verify cards'
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

/**
 * The line that goes out with a shared profile.
 *
 * FIRST PERSON ON YOUR OWN PROFILE, third on anybody else's. The same screen is
 * both, and it used to name the handle either way -- so sharing your own read
 * as "manishbisht scored 2712", written about yourself in the third person.
 *
 * The tier and the verified count do the work the bare number cannot. 2712 is
 * meaningless without knowing it is out of 3000 and what that makes you, and
 * "verified" is the whole difference between this and a list somebody typed.
 */
export function shareLine(profile: {
  isOwn: boolean
  handle: string
  rating: number
  maxScore: number
  tierName: string
  verifiedCount: number
}): string {
  const who = profile.isOwn ? 'I' : profile.handle
  const boast = [profile.tierName]
  // Omitted at zero rather than boasting about none: a wallet nobody has proved
  // yet is exactly what this line should not draw attention to.
  if (profile.verifiedCount > 0) {
    boast.push(`${profile.verifiedCount} verified ${profile.verifiedCount === 1 ? 'card' : 'cards'}`)
  }
  const challenge = profile.isOwn ? 'Think your wallet beats mine?' : 'Think yours beats it?'

  return `${who} scored ${profile.rating}/${profile.maxScore} on Rate My Cards — ${boast.join(', ')}. ${challenge}`
}
