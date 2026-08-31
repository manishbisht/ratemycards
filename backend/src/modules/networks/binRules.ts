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
 * A well-formed glob: digits, '*', and character classes holding digits and
 * digit ranges. This checks STRUCTURE, not just the alphabet, and the
 * difference matters more than it looks.
 *
 * An alphabet-only check admits '4[' and '4[9-0]*', which throw at RegExp
 * construction, and admits '4[]5]*', which is worse: SQLite GLOB reads a ']'
 * straight after '[' as a literal class member, so that glob matches real
 * prefixes -- but JS reads '[]' as an empty class, so the regex silently
 * matches nothing at all. No exception, just a rule that never fires.
 *
 * This is deliberately STRICTER than the CHECK on network_bin_rules in
 * migration 0009, which is a character-set test. SQLite GLOB cannot express
 * well-formedness, so this is the one place the project's
 * "validator mirrors the constraint" rule does not hold. Do not "fix" the
 * asymmetry by loosening this -- the constraint is the coarse backstop and
 * this is the real gate.
 */
const GLOB_SHAPE = /^(?:[0-9]|\*|\[(?:[0-9]-[0-9]|[0-9])+\])+$/

/**
 * No real ISO/IEC 7812 rule needs more than a handful of characters -- the
 * longest this catalog seeds is '64[4-9]*' at 8. The cap exists because
 * globToRegExp turns every '*' into '.*', and a value of ~26 stars costs
 * about 650ms to test against one prefix, ~5x per four stars after that. An
 * admin could otherwise plant one rule and make every card write expensive.
 */
const MAX_GLOB_LENGTH = 24

/**
 * Shape alone still admits a descending range like '[9-0]', which throws
 * 'Range out of order'. GLOB_SHAPE guarantees a '-' only ever sits between two
 * digits inside a class, so scanning the whole string is safe.
 */
function isWellFormedGlob(value: string): boolean {
  if (value.length > MAX_GLOB_LENGTH) return false
  if (!GLOB_SHAPE.test(value)) return false

  for (const match of value.matchAll(/([0-9])-([0-9])/g)) {
    if (Number(match[1]) > Number(match[2])) return false
  }
  return true
}

/** Two 4-digit bounds, low first. */
const RANGE_SHAPE = /^(\d{4})-(\d{4})$/

export function isBinRuleValue(kind: BinRuleKind, value: string): boolean {
  if (kind === 'glob') return isWellFormedGlob(value)

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
