/**
 * A network's BIN prefix rules, and the matcher that applies them.
 *
 * These used to be one CHECK constraint on card_bins, which was the better
 * place for them: no write path could bypass it. A CHECK cannot subquery a
 * table, so once networks became rows an admin can add, the rules had to move
 * here. This module is now the one door -- cards/validate.ts is its only
 * caller, and the admin API is the only write path that reaches it.
 *
 * Pure and DB-free on purpose, so it tests without a Worker.
 */

export const BIN_RULE_KINDS = ['glob', 'range'] as const

export type BinRuleKind = (typeof BIN_RULE_KINDS)[number]

export type BinRule = {
  kind: BinRuleKind
  value: string
}

export function isBinRuleKind(value: unknown): value is BinRuleKind {
  return typeof value === 'string' && (BIN_RULE_KINDS as readonly string[]).includes(value)
}

/**
 * A glob may hold only digits, '[', ']', '-' and '*'. Mirrors the CHECK on
 * network_bin_rules -- change one, change the other -- and it is what makes
 * globToRegExp below safe: no regex metacharacter can reach it.
 */
const GLOB_ALPHABET = /^[0-9[\]\-*]+$/

/** Two 4-digit bounds, low first. */
const RANGE_SHAPE = /^(\d{4})-(\d{4})$/

export function isBinRuleValue(kind: BinRuleKind, value: string): boolean {
  if (kind === 'glob') return GLOB_ALPHABET.test(value)

  const match = RANGE_SHAPE.exec(value)
  return match !== null && Number(match[1]) <= Number(match[2])
}

/**
 * SQLite GLOB and RegExp agree on everything the alphabet above permits: a
 * character class means the same in both, digits are literal in both, and '*'
 * is the only wildcard. So the translation is a single replacement.
 *
 * Anchored at both ends, which is why a rule has to end in '*' to match a
 * prefix longer than itself. '508' matches only the literal string '508'.
 */
function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replaceAll('*', '.*')}$`)
}

/** Inclusive, against the prefix's leading four digits. */
function inRange(prefix: string, value: string): boolean {
  const match = RANGE_SHAPE.exec(value)
  if (!match) return false

  const head = Number.parseInt(prefix.slice(0, 4), 10)
  return head >= Number(match[1]) && head <= Number(match[2])
}

/** A prefix is valid for a network when *any* of its rules matches. */
export function matchesBinRules(prefix: string, rules: BinRule[]): boolean {
  return rules.some((rule) =>
    rule.kind === 'glob' ? globToRegExp(rule.value).test(prefix) : inRange(prefix, rule.value),
  )
}
