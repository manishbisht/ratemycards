/**
 * Public ids are `<prefix>_` followed by 32 hex characters, minted server-side
 * and never accepted from a client. randomUUID is the platform's CSPRNG, so
 * there is no hand-rolled randomness to get wrong.
 */

const HEX_BODY = 32

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

export function idPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}_[0-9a-f]{${HEX_BODY}}$`)
}

/** `card_` + underscore + 32 hex. Kept in step with the CHECK constraints. */
export const ID_LENGTH = (prefix: string): number => prefix.length + 1 + HEX_BODY
