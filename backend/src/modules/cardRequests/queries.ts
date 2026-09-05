import { ApiError } from '../../http/errors'
import { listCards } from '../cards/queries'
import { generateCardRequestId } from './cardRequestTypes'
import type {
  AdminCardRequest,
  CardRequestFilters,
  CardRequestInput,
  CardRequestKind,
  CardRequestStatus,
  RequestCard,
} from './cardRequestTypes'
import type { CardType } from '../cards/cardTypes'

/**
 * This module owns `card_requests` and `card_request_bins`.
 *
 * It takes two liberties, and they are different in kind. It reads `users.handle`
 * across the declared `user_id` foreign key -- a plain column across an FK, the
 * documented relaxation in README.md, the same one `cards` takes on `banks`. It
 * does NOT read `cards` in SQL: the catalog card embedded in a request comes
 * from `cards.listCards`, because `selectable` is a column that module derives,
 * and re-deriving it here would be two copies of one rule waiting to disagree.
 *
 * Nothing here writes to the catalog. An approval records that an admin already
 * did that work through the catalog's own endpoints; see migration 0016.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

type RequestRow = {
  id: string
  user_id: string
  handle: string | null
  kind: CardRequestKind
  card_id: string | null
  bank_id: string | null
  bank_name: string | null
  card_name: string | null
  card_type: CardType | null
  network_code: string
  note: string | null
  status: CardRequestStatus
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  created_at: string
}

const REQUEST_COLUMNS = `r.id, r.user_id, u.handle, r.kind, r.card_id, r.bank_id, r.bank_name,
       r.card_name, r.card_type, r.network_code, r.note, r.status, r.reviewed_by,
       r.reviewed_at, r.review_note, r.created_at`

const FROM_REQUESTS = 'FROM card_requests r LEFT JOIN users u ON u.id = r.user_id'

/** Prefixes for a set of requests, in one query rather than one per request. */
async function binsFor(db: D1Database, ids: string[]): Promise<Map<string, string[]>> {
  const byRequest = new Map<string, string[]>()
  if (ids.length === 0) return byRequest

  const marks = ids.map(() => '?').join(',')
  const { results } = await db
    .prepare(
      `SELECT request_id, bin_prefix FROM card_request_bins
       WHERE request_id IN (${marks}) ORDER BY bin_prefix`,
    )
    .bind(...ids)
    .all<{ request_id: string; bin_prefix: string }>()

  for (const row of results) {
    const existing = byRequest.get(row.request_id)
    if (existing) existing.push(row.bin_prefix)
    else byRequest.set(row.request_id, [row.bin_prefix])
  }
  return byRequest
}

/**
 * The catalog cards a page of requests points at.
 *
 * `includeInactive` and `includeUnselectable` are both on: a request may name a
 * card an admin has since retired, or one with no prefixes yet, and either way
 * the row has to render. Mapped straight down to `RequestCard` so the rating
 * `listCards` carries never travels any further -- `toPublicCard` is the card
 * module's door out, and this is the equivalent narrowing here.
 */
async function cardsFor(db: D1Database, ids: string[]): Promise<Map<string, RequestCard>> {
  const byId = new Map<string, RequestCard>()
  if (ids.length === 0) return byId

  const { cards } = await listCards(db, {
    ids,
    includeInactive: true,
    includeUnselectable: true,
    limit: ids.length,
    offset: 0,
  })

  for (const card of cards) {
    byId.set(card.id, {
      id: card.id,
      name: card.name,
      issuer: card.issuer,
      selectable: card.selectable,
    })
  }
  return byId
}

function toRequest(
  row: RequestRow,
  bins: string[],
  cards: Map<string, RequestCard>,
): AdminCardRequest {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    card: row.card_id ? (cards.get(row.card_id) ?? null) : null,
    proposal:
      row.kind === 'card'
        ? {
            bankId: row.bank_id,
            issuer: row.bank_name ?? '',
            name: row.card_name ?? '',
            type: row.card_type,
          }
        : null,
    network: row.network_code,
    bins,
    note: row.note,
    reviewNote: row.review_note,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    requester: { id: row.user_id, handle: row.handle },
    reviewedBy: row.reviewed_by,
  }
}

/** Rows plus their prefixes plus their cards, in three queries rather than 3n. */
async function hydrate(db: D1Database, rows: RequestRow[]): Promise<AdminCardRequest[]> {
  const bins = await binsFor(
    db,
    rows.map((row) => row.id),
  )
  const cardIds = [...new Set(rows.map((row) => row.card_id).filter((id): id is string => !!id))]
  const cards = await cardsFor(db, cardIds)

  return rows.map((row) => toRequest(row, bins.get(row.id) ?? [], cards))
}

async function page(
  db: D1Database,
  where: string,
  binds: unknown[],
  order: string,
  filters: CardRequestFilters,
): Promise<{ requests: AdminCardRequest[]; total: number }> {
  const [rows, count] = await db.batch<RequestRow & { total: number }>([
    db
      .prepare(
        `SELECT ${REQUEST_COLUMNS} ${FROM_REQUESTS} ${where} ${order} LIMIT ? OFFSET ?`,
      )
      .bind(...binds, filters.limit, filters.offset),
    db.prepare(`SELECT COUNT(*) AS total ${FROM_REQUESTS} ${where}`).bind(...binds),
  ])

  return {
    requests: await hydrate(db, rows.results as RequestRow[]),
    total: count.results[0]?.total ?? 0,
  }
}

export async function listRequestsForUser(
  db: D1Database,
  userId: string,
  filters: CardRequestFilters,
): Promise<{ requests: AdminCardRequest[]; total: number }> {
  const conds = ['r.user_id = ?']
  const binds: unknown[] = [userId]
  if (filters.status) {
    conds.push('r.status = ?')
    binds.push(filters.status)
  }

  return page(db, `WHERE ${conds.join(' AND ')}`, binds, 'ORDER BY r.created_at DESC', filters)
}

/**
 * The review queue.
 *
 * Ordered so identical asks sit next to each other rather than by arrival: ten
 * people wanting the same card is the most useful thing in this table, and
 * clustering them costs nothing. 'bin' requests group by the card they target,
 * 'card' requests by issuer then product.
 */
export async function listRequestsForReview(
  db: D1Database,
  filters: CardRequestFilters,
): Promise<{ requests: AdminCardRequest[]; total: number }> {
  const conds: string[] = []
  const binds: unknown[] = []
  if (filters.status) {
    conds.push('r.status = ?')
    binds.push(filters.status)
  }

  return page(
    db,
    conds.length ? `WHERE ${conds.join(' AND ')}` : '',
    binds,
    `ORDER BY r.kind ASC,
              COALESCE(r.bank_name, r.card_id) COLLATE NOCASE ASC,
              COALESCE(r.card_name, '') COLLATE NOCASE ASC,
              r.created_at ASC`,
    filters,
  )
}

/**
 * One request. `userId` scopes it to its owner, which is what makes somebody
 * else's id a 404 rather than a 403 -- the same choice `verification.getAttempt`
 * makes. Omit it for the admin paths, which are allowed to see every row.
 */
export async function getRequest(
  db: D1Database,
  id: string,
  userId?: string,
): Promise<AdminCardRequest | null> {
  const where = userId ? 'WHERE r.id = ? AND r.user_id = ?' : 'WHERE r.id = ?'
  const binds = userId ? [id, userId] : [id]

  const row = await db
    .prepare(`SELECT ${REQUEST_COLUMNS} ${FROM_REQUESTS} ${where}`)
    .bind(...binds)
    .first<RequestRow>()
  if (!row) return null

  const [hydrated] = await hydrate(db, [row])
  return hydrated ?? null
}

/** How many requests this person already has open, for MAX_OPEN_REQUESTS. */
export async function countOpenRequests(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM card_requests WHERE user_id = ? AND status = 'pending'")
    .bind(userId)
    .first<{ total: number }>()
  return row?.total ?? 0
}

/**
 * What the route settled before we write: the issuer it resolved (or did not),
 * under the name it will be recorded as.
 *
 * `bankName` is written even when `bankId` resolved, because it is half the
 * dedupe index in 0016 and SQLite counts NULLs in a unique index as distinct.
 */
export type ResolvedIssuer = { bankId: string | null; bankName: string | null }

export async function createRequest(
  db: D1Database,
  userId: string,
  input: CardRequestInput,
  issuer: ResolvedIssuer,
): Promise<AdminCardRequest> {
  const id = generateCardRequestId()

  const statements = [
    db
      .prepare(
        `INSERT INTO card_requests
           (id, user_id, kind, card_id, bank_id, bank_name, card_name, card_type,
            network_code, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        userId,
        input.kind,
        input.kind === 'bin' ? (input.cardId ?? null) : null,
        input.kind === 'card' ? issuer.bankId : null,
        input.kind === 'card' ? issuer.bankName : null,
        input.kind === 'card' ? (input.cardName ?? null) : null,
        input.kind === 'card' ? (input.cardType ?? null) : null,
        input.network,
        input.note ?? null,
      ),
    ...input.bins.map((prefix) =>
      db
        .prepare('INSERT INTO card_request_bins (request_id, bin_prefix) VALUES (?, ?)')
        .bind(id, prefix),
    ),
  ]

  try {
    await db.batch(statements)
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      throw ApiError.conflict(
        input.kind === 'bin'
          ? 'You already have an open request for that card.'
          : `You already have an open request for '${input.cardName}'.`,
      )
    }
    throw err
  }

  const created = await getRequest(db, id)
  if (!created) throw new Error(`Request ${id} vanished immediately after being written.`)
  return created
}

/**
 * Deletes a pending request and its prefixes.
 *
 * Children first and no ON DELETE CASCADE, matching card_bins in 0009. The
 * status is re-checked in the parent's WHERE as well as read above it, so a
 * request settled between the two never loses its prefixes.
 */
export async function deleteRequest(db: D1Database, id: string, userId: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM card_request_bins WHERE request_id IN (
           SELECT id FROM card_requests WHERE id = ? AND user_id = ? AND status = 'pending')`,
      )
      .bind(id, userId),
    db
      .prepare("DELETE FROM card_requests WHERE id = ? AND user_id = ? AND status = 'pending'")
      .bind(id, userId),
  ])
}

/**
 * Settles a request.
 *
 * `status = 'pending'` sits in the WHERE rather than in a check above it, so two
 * admins clicking at once cannot both settle the same row: the second update
 * changes nothing, and the caller turns that into a 409. Read-then-write would
 * have let both through.
 */
async function settle(
  db: D1Database,
  id: string,
  status: Exclude<CardRequestStatus, 'pending'>,
  input: { cardId: string | null; reviewedBy: string | null; note: string | null },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE card_requests
       SET status = ?, card_id = COALESCE(?, card_id), reviewed_by = ?,
           review_note = ?, reviewed_at = ${NOW}, updated_at = ${NOW}
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(status, input.cardId, input.reviewedBy, input.note, id)
    .run()

  return (result.meta.changes ?? 0) > 0
}

export async function approveRequest(
  db: D1Database,
  id: string,
  input: { cardId: string; reviewedBy: string | null; note: string | null },
): Promise<boolean> {
  return settle(db, id, 'approved', input)
}

export async function rejectRequest(
  db: D1Database,
  id: string,
  input: { reviewedBy: string | null; note: string },
): Promise<boolean> {
  return settle(db, id, 'rejected', { cardId: null, reviewedBy: input.reviewedBy, note: input.note })
}
