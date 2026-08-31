import { ApiError } from '../../http/errors'
import { likePattern } from '../../http/params'
import { COUNT_ACTIVE_CRITERIA_SQL, countActiveCriteria } from '../scoring/queries'
import { toRating } from '../scoring/scoringTypes'
import type { RatingRow } from '../scoring/scoringTypes'
import { generateCardId } from './cardTypes'
import type {
  CardFilters,
  CardInput,
  CardNetwork,
  CardNetworkInput,
  CardPatch,
  CardType,
  RatedCard,
} from './cardTypes'
import type { VerificationStatus } from '../wallet/walletTypes'

/**
 * This module owns the `cards`, `card_networks` and `card_bins` tables. It
 * *reads* `banks`, the scoring tables
 * and -- for a signed-in caller -- `wallet_cards`, which is the one documented
 * exception to modules keeping to their own tables. It never writes to any of
 * them.
 */

type CardRow = RatingRow & {
  id: string
  name: string
  country: string
  type: string
  joining_fee: number
  annual_fee: number
  is_active: number
  bank_id: string
  bank_name: string
  // Only selected when a caller is known; NULL for a card they do not hold.
  wallet_status?: VerificationStatus | null
  wallet_verified_at?: string | null
}

const CARD_COLUMNS = `c.id, c.name, c.country, c.type, c.joining_fee, c.annual_fee, c.is_active,
  c.bank_id, b.name AS bank_name, r.weighted_sum, r.weight_total, r.scored_count`

const WALLET_COLUMNS = `, w.verification_status AS wallet_status, w.verified_at AS wallet_verified_at`

/**
 * Folds the caller's own wallet state into the same query rather than following
 * up per card. The user id binds inside the JOIN, so it comes first in the bind
 * list -- ahead of anything the WHERE clause contributes.
 */
const WALLET_JOIN = `
  LEFT JOIN wallet_cards w ON w.card_id = c.id AND w.user_id = ?`

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

/** Kept out of the page query's template so the ORDER BY has one home. */
const PAGE_ORDER = 'ORDER BY b.name COLLATE NOCASE ASC, c.name COLLATE NOCASE ASC'

function toCard(row: CardRow, totalCriteria: number, withWallet: boolean): RatedCard {
  return {
    id: row.id,
    name: row.name,
    bank: { id: row.bank_id, name: row.bank_name },
    // Not a column: the bank's name, under the field the frontend renders.
    issuer: row.bank_name,
    country: row.country,
    type: row.type as CardType,
    joiningFee: row.joining_fee,
    annualFee: row.annual_fee,
    isActive: row.is_active === 1,
    // Omitted entirely for anonymous callers: an absent key and a false one say
    // different things, and the public shape must not gain a field.
    ...(withWallet
      ? {
          wallet: {
            inWallet: row.wallet_status != null,
            verificationStatus: row.wallet_status ?? 'unverified',
            verifiedAt: row.wallet_verified_at ?? null,
          },
        }
      : {}),
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

  if (!f.includeInactive) {
    conds.push('c.is_active = 1')
    // A retired issuer takes its cards with it. Without this, deactivating a
    // bank left every one of its cards in the catalog.
    conds.push('b.is_active = 1')
  }

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
  if (f.network) {
    // EXISTS rather than a join: a card on two networks must still count once.
    // The filter takes a code, not an id -- ids never leave the server.
    conds.push(
      `EXISTS (SELECT 1 FROM card_networks cn
               JOIN networks nw ON nw.id = cn.network_id
               WHERE cn.card_id = c.id AND nw.code = ?)`,
    )
    binds.push(f.network)
  }
  if (f.ids) {
    conds.push(`c.id IN (${placeholders(f.ids.length)})`)
    binds.push(...f.ids)
  }

  /*
   * A card with no BIN prefixes cannot be verified, so it is not offered.
   *
   * Discovery-scoped, and the `!f.ids` is the whole point: an explicit ids=
   * lookup is resolving cards someone already holds, and three call sites do
   * exactly that -- getWallet, /wallet/preview and knownCardIds. Gating them
   * would drop held cards from a wallet and change its score, and the prune
   * listener in frontend/src/store/store.ts would then delete them from the
   * browser's copy for good.
   */
  if (!f.includeUnselectable && !f.ids) {
    conds.push('EXISTS (SELECT 1 FROM card_bins cb WHERE cb.card_id = c.id)')
  }

  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', binds }
}

/**
 * `userId` turns on the wallet columns. The COUNT deliberately skips the wallet
 * join: it counts catalog rows, which the caller's holdings cannot change, and
 * leaving it out keeps the count's bind list independent of the page's.
 */
export async function listCards(
  db: D1Database,
  filters: CardFilters,
  userId?: string,
): Promise<{ cards: RatedCard[]; total: number }> {
  const { clause, binds } = buildWhere(filters)
  const withWallet = userId !== undefined

  // One round trip for the page and its unpaginated total. Every join is
  // many-to-one, so none can fan a card out across rows.
  //
  // A card's networks are deliberately NOT fetched here. They are one-to-many
  // and would fan a card across rows; more to the point the public card does
  // not carry them -- see the note on card_networks in the README.
  const [page, count, criteria] = await db.batch<CardRow & { total: number }>([
    db
      .prepare(
        `SELECT ${CARD_COLUMNS}${withWallet ? WALLET_COLUMNS : ''} ${FROM_CARDS}${withWallet ? WALLET_JOIN : ''} ${clause}
         ${PAGE_ORDER} LIMIT ? OFFSET ?`,
      )
      .bind(...(withWallet ? [userId] : []), ...binds, filters.limit, filters.offset),
    db.prepare(`SELECT COUNT(*) AS total ${FROM_CARDS} ${clause}`).bind(...binds),
    db.prepare(COUNT_ACTIVE_CRITERIA_SQL),
  ])

  const totalCriteria = criteria.results[0]?.total ?? 0
  return {
    cards: (page.results as CardRow[]).map((row) => toCard(row, totalCriteria, withWallet)),
    total: count.results[0]?.total ?? 0,
  }
}

export async function getCard(
  db: D1Database,
  id: string,
  userId?: string,
): Promise<RatedCard | null> {
  const withWallet = userId !== undefined

  const row = await db
    .prepare(
      `SELECT ${CARD_COLUMNS}${withWallet ? WALLET_COLUMNS : ''} ${FROM_CARDS}${withWallet ? WALLET_JOIN : ''} WHERE c.id = ?`,
    )
    .bind(...(withWallet ? [userId] : []), id)
    .first<CardRow>()

  return row ? toCard(row, await countActiveCriteria(db), withWallet) : null
}

/**
 * A card's networks with the BIN prefixes behind each. Not on the public card --
 * see the note in cardTypes.ts -- so this is the one door to it, and it exists
 * for the verification module rather than for a response.
 *
 * One query, and the LEFT JOIN means a network with no prefixes still appears.
 */
export async function listCardNetworks(
  db: D1Database,
  cardId: string,
): Promise<CardNetwork[]> {
  const { results } = await db
    .prepare(
      `SELECT nw.code AS network, cb.bin_prefix
       FROM card_networks cn
       JOIN networks nw ON nw.id = cn.network_id
       LEFT JOIN card_bins cb ON cb.card_id = cn.card_id AND cb.network_id = cn.network_id
       WHERE cn.card_id = ?
       ORDER BY nw.code, cb.bin_prefix`,
    )
    .bind(cardId)
    .all<{ network: string; bin_prefix: string | null }>()

  const networks: CardNetwork[] = []
  for (const row of results) {
    let entry = networks.find((n) => n.network === row.network)
    if (!entry) networks.push((entry = { network: row.network, bins: [] }))
    if (row.bin_prefix !== null) entry.bins.push(row.bin_prefix)
  }

  return networks
}

async function requireCard(db: D1Database, id: string): Promise<void> {
  const found = await db.prepare('SELECT 1 FROM cards WHERE id = ?').bind(id).first()
  if (!found) throw ApiError.notFound(`Card '${id}'`)
}

/**
 * Replaces a card's whole network *and* BIN set, matching PUT
 * /v1/cards/:id/scores rather than merging: repeated calls cannot accumulate
 * duplicates.
 *
 * Statement order matters and is not incidental. card_bins has a composite
 * foreign key onto card_networks, so every BIN goes before its parent can be
 * removed and after its parent exists:
 *
 *   1. delete all the card's BINs        -- frees the FK
 *   2. delete the networks not being kept
 *   3. insert the networks               -- parents first
 *   4. insert the BINs                   -- children second
 *
 * Wiping all the BINs in step 1 rather than only the dropped networks' is what
 * makes this a replace. It also retires the 409 this used to raise: the caller
 * has stated both halves, so there is no unmentioned data to protect.
 */
async function replaceNetworks(
  db: D1Database,
  cardId: string,
  networks: CardNetworkInput[],
  idByCode: Map<string, string>,
): Promise<void> {
  const ids = networks.map((n) => idByCode.get(n.code)).filter((id): id is string => id !== undefined)

  // `NOT IN ()` is not valid SQL, so an empty set drops the clause rather than
  // emitting it -- which is exactly the `networks: []` case.
  const keep = ids.length > 0 ? `AND network_id NOT IN (${placeholders(ids.length)})` : ''

  const statements = [
    db.prepare('DELETE FROM card_bins WHERE card_id = ?').bind(cardId),
    db.prepare(`DELETE FROM card_networks WHERE card_id = ? ${keep}`).bind(cardId, ...ids),
  ]

  for (const network of networks) {
    const networkId = idByCode.get(network.code)
    if (networkId === undefined) continue
    statements.push(
      db
        .prepare(
          'INSERT INTO card_networks (card_id, network_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
        )
        .bind(cardId, networkId),
    )
  }

  for (const network of networks) {
    const networkId = idByCode.get(network.code)
    if (networkId === undefined) continue
    for (const bin of network.bins) {
      statements.push(
        db
          .prepare('INSERT INTO card_bins (card_id, network_id, bin_prefix) VALUES (?, ?, ?)')
          .bind(cardId, networkId, bin),
      )
    }
  }

  await db.batch(statements)
}

export async function createCard(
  db: D1Database,
  input: CardInput,
  idByCode: Map<string, string>,
): Promise<RatedCard> {
  const id = generateCardId()

  try {
    await db
      .prepare(
        `INSERT INTO cards (id, bank_id, name, country, type, joining_fee, annual_fee, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.bankId,
        input.name,
        input.country,
        input.type ?? 'credit',
        input.joiningFee,
        input.annualFee,
        input.isActive === false ? 0 : 1,
      )
      .run()
  } catch (err) {
    throw mapWriteError(err, input.name)
  }

  if (input.networks !== undefined) {
    await replaceNetworks(db, id, input.networks, idByCode)
  }

  const card = await getCard(db, id)
  if (!card) throw new Error(`Card '${id}' vanished immediately after insert`)
  return card
}

export async function updateCard(
  db: D1Database,
  id: string,
  patch: CardPatch,
  idByCode: Map<string, string>,
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
  assign('type', patch.type)
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

  if (patch.networks !== undefined) {
    await replaceNetworks(db, id, patch.networks, idByCode)
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
