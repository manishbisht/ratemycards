import { checkId, checkText, isPlainObject, rejectClientId } from '../../http/validators'
import { CRITERION_ID_PATTERN, MAX_SCORE, MAX_WEIGHT, MIN_SCORE } from './scoringTypes'
import type { CriterionInput, CriterionPatch, ScoreInput } from './scoringTypes'

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

function checkWeight(value: unknown, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_WEIGHT) {
    errors.push(`weight must be an integer between 0 and ${MAX_WEIGHT}.`)
    return undefined
  }
  return value
}

export function validateCriterionInput(body: unknown): Validated<CriterionInput> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)
  const name = checkText(body.name, 'name', 80, errors)
  const weight = body.weight === undefined ? 1 : checkWeight(body.weight, errors)
  const description =
    body.description === undefined || body.description === null
      ? null
      : checkText(body.description, 'description', 300, errors)

  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    errors.push('isActive must be a boolean.')
  }

  if (errors.length > 0 || name === undefined || weight === undefined) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    value: { name, description, weight, isActive: body.isActive as boolean | undefined },
  }
}

export function validateCriterionPatch(body: unknown): Validated<CriterionPatch> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)

  const patch: CriterionPatch = {}
  if (body.name !== undefined) patch.name = checkText(body.name, 'name', 80, errors)
  if (body.description !== undefined) {
    patch.description =
      body.description === null ? null : checkText(body.description, 'description', 300, errors)
  }
  if (body.weight !== undefined) patch.weight = checkWeight(body.weight, errors)
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') errors.push('isActive must be a boolean.')
    else patch.isActive = body.isActive
  }

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push('Provide at least one field to update.')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: patch }
}

/** The whole score set for one card. An empty array clears its scores. */
export function validateScoresBody(body: unknown): Validated<ScoreInput[]> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }
  if (!Array.isArray(body.scores)) {
    return { ok: false, errors: ['scores is required and must be an array; send [] to clear them.'] }
  }

  const parsed: ScoreInput[] = []
  const seen = new Set<string>()

  body.scores.forEach((raw: unknown, index: number) => {
    if (!isPlainObject(raw)) {
      errors.push(`scores[${index}] must be an object.`)
      return
    }

    const criterionId = checkId(
      raw.criterionId,
      `scores[${index}].criterionId`,
      CRITERION_ID_PATTERN,
      errors,
    )
    const score = raw.score
    if (
      typeof score !== 'number' ||
      !Number.isInteger(score) ||
      score < MIN_SCORE ||
      score > MAX_SCORE
    ) {
      errors.push(`scores[${index}].score must be an integer between ${MIN_SCORE} and ${MAX_SCORE}.`)
      return
    }
    if (criterionId === undefined) return

    // Caught here so the client gets a field-level 400 rather than an opaque
    // primary-key violation from the database.
    if (seen.has(criterionId)) {
      errors.push(`scores[${index}] scores the same criterion twice.`)
      return
    }
    seen.add(criterionId)
    parsed.push({ criterionId, score })
  })

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: parsed }
}
