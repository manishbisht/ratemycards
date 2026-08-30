/** Shared query-string parsing. Every helper is total: bad input gets the default. */

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100
/**
 * Bounds the `IN (?,?,...)` statement built for an `ids=` lookup. D1 caps bound
 * parameters at 100 per query and the same statement also binds the active
 * filters plus limit/offset, so 50 leaves real headroom.
 */
export const MAX_IDS = 50

export function parseLimit(raw: string | undefined): number {
  const n = Number(raw)
  if (!raw || !Number.isInteger(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

export function parseOffset(raw: string | undefined): number {
  const n = Number(raw)
  if (!raw || !Number.isInteger(n) || n < 0) return 0
  return n
}

/** For optional numeric filters: junk is ignored rather than erroring. */
export function parseNonNegativeInt(raw: string | undefined): number | undefined {
  const n = Number(raw)
  if (raw === undefined || !Number.isInteger(n) || n < 0) return undefined
  return n
}

export function parseBool(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1'
}

/** `ids=infinia,atlas` -> ['infinia', 'atlas'], de-duplicated and capped. */
export function parseIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))]
  return ids.slice(0, MAX_IDS)
}

/**
 * `%` and `_` are LIKE wildcards, so unescaped user input turns `q=%` into
 * "match everything". Pairs with `ESCAPE '\'` on the clause.
 */
export function likePattern(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, '\\$&')}%`
}
