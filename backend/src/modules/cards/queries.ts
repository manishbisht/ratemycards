import { ApiError } from '../../http/errors'
import { likePattern } from '../../http/params'
import { countActiveCriteria } from '../scoring/queries'
import { toRating } from '../scoring/scoringTypes'
import type { RatingRow } from '../scoring/scoringTypes'
import { generateCardId } from './cardTypes'
import type { CardFilters, CardInput, CardPatch, RatedCard } from './cardTypes'

/**
 * This module owns the `cards` table. It *reads* `banks` and the scoring
 * tables through their foreign keys -- to embed the issuer name and to derive
 * the rating -- which is the one documented exception to modules keeping to
 * their own tables. It never writes to either.
 */

type CardRow = RatingRow & {
  id: string
  name: string
  country: string
  joining_fee: number
  annual_fee: number
  is_active: number
  bank_id: string
  bank_name: string
}

const CARD_COLUMNS = `c.id, c.name, c.country, c.joining_fee, c.annual_fee, c.is_active,
  c.bank_id, b.name AS bank_name, r.weighted_sum, r.weight_total, r.scored_count`

/**
 * The rating is aggregated in a derived table and joined in, so a page of
 * cards costs one query rather than one per card. Only *active* criteria
 * count, so deactivating a criterion re-rates every card immediately.
 */
const FROM_CARDS = `FROM cards c
  JOIN banks b ON b.id = c.bank_id
  LEFT JOIN (
    SELECT s.card_id,
           SUM(s.score * sc.weight) AS weighted_sum,
           SUM(sc.weight)           AS weight_total,
           COUNT(*)                 AS scored_count
    FROM card_scores s
    JOIN scoring_criteria sc ON sc.id = s.criterion_id AND sc.is_active = 1
    GROUP BY s.card_id
  ) r ON r.card_id = c.id`
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

function toCard(row: CardRow, totalCriteria: number): RatedCard {
  return {
    id: row.id,
    name: row.name,
    bank: { id: row.bank_id, name: row.bank_name },
    // Not a column: the bank's name, under the field the frontend renders.
    issuer: row.bank_name,
    country: row.country,
    joiningFee: row.joining_fee,
    annualFee: row.annual_fee,
    isActive: row.is_active === 1,
    rating: toRating(row, totalCriteria),
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',')
}

/** Shared by the page query and its COUNT, so the two can never disagree. */
function buildWhere(f: CardFilters): { clause: string; binds: unknown[] } {
  // An explicit but empty `ids=` means "none of them", whatever else is set.
  if (f.ids && f.ids.length === 0) return { clause: 'WHERE 0', binds: [] }

  const conds: string[] = []
  const binds: unknown[] = []

  if (!f.includeInactive) conds.push('c.is_active = 1')

  if (f.q) {
    // Searches the card name and the issuing bank's name.
    const pattern = likePattern(f.q)
    conds.push("(c.name LIKE ? ESCAPE '\\' OR b.name LIKE ? ESCAPE '\\')")
    binds.push(pattern, pattern)
  }
  if (f.bankId) {
    conds.push('c.bank_id = ?')
    binds.push(f.bankId)
  }
  if (f.country) {
    conds.push('c.country = ?')
    binds.push(f.country)
  }
  if (f.maxAnnualFee !== undefined) {
    conds.push('c.annual_fee <= ?')
    binds.push(f.maxAnnualFee)
  }
  if (f.ids) {
    conds.push(`c.id IN (${placeholders(f.ids.length)})`)
    binds.push(...f.ids)
  }

  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', binds }
}

export async function listCards(
  db: D1Database,
  filters: CardFilters,
): Promise<{ cards: RatedCard[]; total: number }> {
  const { clause, binds } = buildWhere(filters)

  // One round trip for the page and its unpaginated total. The join is
  // many-to-one, so it cannot fan a card out across rows.
  const [page, count, criteria] = await db.batch<CardRow & { total: number }>([
    db
      .prepare(
        `SELECT ${CARD_COLUMNS} ${FROM_CARDS} ${clause}
         ORDER BY b.name COLLATE NOCASE ASC, c.name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, filters.limit, filters.offset),
    db.prepare(`SELECT COUNT(*) AS total ${FROM_CARDS} ${clause}`).bind(...binds),
    db.prepare('SELECT COUNT(*) AS total FROM scoring_criteria WHERE is_active = 1'),
  ])

  const totalCriteria = criteria.results[0]?.total ?? 0
  return {
    cards: (page.results as CardRow[]).map((row) => toCard(row, totalCriteria)),
    total: count.results[0]?.total ?? 0,
  }
}

export async function getCard(db: D1Database, id: string): Promise<RatedCard | null> {
  const row = await db
    .prepare(`SELECT ${CARD_COLUMNS} ${FROM_CARDS} WHERE c.id = ?`)
    .bind(id)
    .first<CardRow>()
  return row ? toCard(row, await countActiveCriteria(db)) : null
}

async function requireCard(db: D1Database, id: string): Promise<void> {
  const found = await db.prepare('SELECT 1 FROM cards WHERE id = ?').bind(id).first()
  if (!found) throw ApiError.notFound(`Card '${id}'`)
}

export async function createCard(db: D1Database, input: CardInput): Promise<RatedCard> {
  const id = generateCardId()

  try {
    await db
      .prepare(
        `INSERT INTO cards (id, bank_id, name, country, joining_fee, annual_fee, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.bankId,
        input.name,
        input.country,
        input.joiningFee,
        input.annualFee,
        input.isActive === false ? 0 : 1,
      )
      .run()
  } catch (err) {
    throw mapWriteError(err, input.name)
  }

  const card = await getCard(db, id)
  if (!card) throw new Error(`Card '${id}' vanished immediately after insert`)
  return card
}

export async function updateCard(
  db: D1Database,
  id: string,
  patch: CardPatch,
): Promise<RatedCard> {
  await requireCard(db, id)

  const sets: string[] = []
  const binds: unknown[] = []
  const assign = (column: string, value: unknown) => {
    if (value === undefined) return
    sets.push(`${column} = ?`)
    binds.push(value)
  }

  assign('bank_id', patch.bankId)
  assign('name', patch.name)
  assign('country', patch.country)
  assign('joining_fee', patch.joiningFee)
  assign('annual_fee', patch.annualFee)
  assign('is_active', patch.isActive === undefined ? undefined : patch.isActive ? 1 : 0)

  if (sets.length > 0) {
    sets.push(`updated_at = ${NOW}`)
    try {
      await db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run()
    } catch (err) {
      throw mapWriteError(err, patch.name ?? id)
    }
  }

  const card = await getCard(db, id)
  if (!card) throw ApiError.notFound(`Card '${id}'`)
  return card
}

/** Soft delete: the catalog keeps history, and wallets referencing it still resolve. */
export async function deactivateCard(db: D1Database, id: string): Promise<void> {
  await requireCard(db, id)
  await db.prepare(`UPDATE cards SET is_active = 0, updated_at = ${NOW} WHERE id = ?`).bind(id).run()
}

/**
 * D1 enforces foreign keys, so an unknown bankId is caught by the database even
 * if it slipped past validation. Both constraints are mapped rather than left
 * to surface as a 500.
 */
function mapWriteError(err: unknown, name: string): unknown {
  if (!(err instanceof Error)) return err
  if (/UNIQUE constraint failed/i.test(err.message)) {
    return ApiError.conflict(`That bank already has a card named '${name}'.`)
  }
  if (/FOREIGN KEY constraint failed/i.test(err.message)) {
    return ApiError.validation(['bankId does not match a known bank.'])
  }
  return err
}
