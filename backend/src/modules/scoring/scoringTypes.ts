import { generateId, idPattern } from '../../http/ids'

export const CRITERION_ID_PREFIX = 'crit'
export const CRITERION_ID_PATTERN = idPattern(CRITERION_ID_PREFIX)

export function generateCriterionId(): string {
  return generateId(CRITERION_ID_PREFIX)
}

/** Scores run 0-10 on every criterion, so they stay comparable across the rubric. */
export const MIN_SCORE = 0
export const MAX_SCORE = 10
export const MAX_WEIGHT = 100

export type Criterion = {
  id: string
  name: string
  /** What the criterion measures. Null when nobody has written one. */
  description: string | null
  weight: number
  isActive: boolean
}

export type CriterionInput = {
  name: string
  description?: string | null
  weight?: number
  isActive?: boolean
}

export type CriterionPatch = Partial<CriterionInput>

export type CriterionFilters = {
  q?: string
  includeInactive: boolean
  limit: number
  offset: number
}

/** One card's score against one criterion, with the criterion inlined. */
export type CardScore = {
  criterion: Criterion
  score: number
}

export type ScoreInput = {
  criterionId: string
  score: number
}

/**
 * Derived on read, never stored. `score` is the weighted average over the
 * card's scores on *active* criteria; it is null when the card has none.
 * `scoredCriteria` against `totalCriteria` is how a caller tells a genuine 9
 * from a 9 based on one lucky criterion.
 */
export type Rating = {
  score: number | null
  max: number
  scoredCriteria: number
  totalCriteria: number
}

export type RatingRow = {
  weighted_sum: number | null
  weight_total: number | null
  scored_count: number | null
}

export function toRating(row: RatingRow, totalCriteria: number): Rating {
  const weightTotal = row.weight_total ?? 0
  const weightedSum = row.weighted_sum ?? 0
  return {
    // Every scored criterion could weigh 0, which is a real configuration and
    // must not divide by zero.
    score: weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 100) / 100 : null,
    max: MAX_SCORE,
    scoredCriteria: row.scored_count ?? 0,
    totalCriteria,
  }
}
