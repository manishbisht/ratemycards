import { ApiError } from '../../http/errors'
import { likePattern } from '../../http/params'
import { generateCriterionId } from './scoringTypes'
import type {
  CardScore,
  Criterion,
  CriterionFilters,
  CriterionInput,
  CriterionPatch,
  ScoreInput,
} from './scoringTypes'

/**
 * This module owns `scoring_criteria` and `card_scores` -- the rubric. The
 * cards module reads the rating aggregate through the card_scores foreign key,
 * which is the documented cross-module read; it never writes here.
 */

type CriterionRow = {
  id: string
  name: string
  description: string | null
  weight: number
  is_active: number
}

const CRITERION_COLUMNS = 'id, name, description, weight, is_active'
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

function toCriterion(row: CriterionRow): Criterion {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    weight: row.weight,
    isActive: row.is_active === 1,
  }
}

function buildWhere(f: CriterionFilters): { clause: string; binds: unknown[] } {
  const conds: string[] = []
  const binds: unknown[] = []

  if (!f.includeInactive) conds.push('is_active = 1')
  if (f.q) {
    conds.push("name LIKE ? ESCAPE '\\'")
    binds.push(likePattern(f.q))
  }

  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', binds }
}

export async function listCriteria(
  db: D1Database,
  filters: CriterionFilters,
): Promise<{ criteria: Criterion[]; total: number }> {
  const { clause, binds } = buildWhere(filters)

  const [page, count] = await db.batch<CriterionRow & { total: number }>([
    db
      .prepare(
        `SELECT ${CRITERION_COLUMNS} FROM scoring_criteria ${clause}
         ORDER BY weight DESC, name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, filters.limit, filters.offset),
    db.prepare(`SELECT COUNT(*) AS total FROM scoring_criteria ${clause}`).bind(...binds),
  ])

  return {
    criteria: (page.results as CriterionRow[]).map(toCriterion),
    total: count.results[0]?.total ?? 0,
  }
}

export async function getCriterion(db: D1Database, id: string): Promise<Criterion | null> {
  const row = await db
    .prepare(`SELECT ${CRITERION_COLUMNS} FROM scoring_criteria WHERE id = ?`)
    .bind(id)
    .first<CriterionRow>()
  return row ? toCriterion(row) : null
}

async function requireCriterion(db: D1Database, id: string): Promise<void> {
  const found = await db.prepare('SELECT 1 FROM scoring_criteria WHERE id = ?').bind(id).first()
  if (!found) throw ApiError.notFound(`Criterion '${id}'`)
}

export async function createCriterion(db: D1Database, input: CriterionInput): Promise<Criterion> {
  const id = generateCriterionId()

  try {
    await db
      .prepare(
        `INSERT INTO scoring_criteria (id, name, description, weight, is_active)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, input.name, input.description ?? null, input.weight ?? 1, input.isActive === false ? 0 : 1)
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict(`A criterion named '${input.name}' already exists.`)
    }
    throw err
  }

  const criterion = await getCriterion(db, id)
  if (!criterion) throw new Error(`Criterion '${id}' vanished immediately after insert`)
  return criterion
}

export async function updateCriterion(
  db: D1Database,
  id: string,
  patch: CriterionPatch,
): Promise<Criterion> {
  await requireCriterion(db, id)

  const sets: string[] = []
  const binds: unknown[] = []
  const assign = (column: string, value: unknown) => {
    if (value === undefined) return
    sets.push(`${column} = ?`)
    binds.push(value)
  }

  assign('name', patch.name)
  assign('description', patch.description)
  assign('weight', patch.weight)
  assign('is_active', patch.isActive === undefined ? undefined : patch.isActive ? 1 : 0)

  if (sets.length > 0) {
    sets.push(`updated_at = ${NOW}`)
    try {
      await db
        .prepare(`UPDATE scoring_criteria SET ${sets.join(', ')} WHERE id = ?`)
        .bind(...binds, id)
        .run()
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw ApiError.conflict('Another criterion already uses that name.')
      }
      throw err
    }
  }

  const criterion = await getCriterion(db, id)
  if (!criterion) throw ApiError.notFound(`Criterion '${id}'`)
  return criterion
}

/**
 * Soft delete. card_scores holds a foreign key to criteria, and a deactivated
 * criterion drops out of every rating without its history being destroyed.
 */
export async function deactivateCriterion(db: D1Database, id: string): Promise<void> {
  await requireCriterion(db, id)
  await db
    .prepare(`UPDATE scoring_criteria SET is_active = 0, updated_at = ${NOW} WHERE id = ?`)
    .bind(id)
    .run()
}

/** The scores on one card, newest rubric first, with each criterion inlined. */
export async function getCardScores(db: D1Database, cardId: string): Promise<CardScore[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.description, c.weight, c.is_active, s.score
       FROM card_scores s
       JOIN scoring_criteria c ON c.id = s.criterion_id
       WHERE s.card_id = ?
       ORDER BY c.weight DESC, c.name COLLATE NOCASE ASC`,
    )
    .bind(cardId)
    .all<CriterionRow & { score: number }>()

  return results.map((row) => ({ criterion: toCriterion(row), score: row.score }))
}

/**
 * Replaces a card's whole score set in one atomic batch, so repeated calls
 * cannot accumulate duplicates or leave a half-written rubric behind.
 */
export async function replaceCardScores(
  db: D1Database,
  cardId: string,
  scores: ScoreInput[],
): Promise<void> {
  try {
    await db.batch([
      db.prepare('DELETE FROM card_scores WHERE card_id = ?').bind(cardId),
      ...scores.map((entry) =>
        db
          .prepare('INSERT INTO card_scores (card_id, criterion_id, score) VALUES (?, ?, ?)')
          .bind(cardId, entry.criterionId, entry.score),
      ),
    ])
  } catch (err) {
    // D1 enforces foreign keys, so an unknown criterionId is caught here even
    // if it somehow passed validation.
    if (err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message)) {
      throw ApiError.validation(['One or more criterionId values do not match a known criterion.'])
    }
    throw err
  }
}

/**
 * Exported as SQL, not just as the function below, because cards/queries.ts
 * needs it as a prepared statement inside a db.batch rather than as its own
 * round trip.
 */
export const COUNT_ACTIVE_CRITERIA_SQL =
  'SELECT COUNT(*) AS total FROM scoring_criteria WHERE is_active = 1'

export async function countActiveCriteria(db: D1Database): Promise<number> {
  const row = await db.prepare(COUNT_ACTIVE_CRITERIA_SQL).first<{ total: number }>()
  return row?.total ?? 0
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}
