import { listCards } from '../cards/queries'
import { toPublicCard } from '../cards/cardTypes'
import { listProvedCards } from '../verification/queries'
import { scoreWallet } from './walletTypes'
import type { StoredWallet, VerificationStatus, WalletCard } from './walletTypes'

type WalletRow = {
  card_id: string
  verification_status: VerificationStatus
  verified_at: string | null
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

/**
 * The rows only. Kept separate from `getWallet` because the write paths need to
 * know what is held without paying for the card lookup and scoring.
 */
export async function listWalletRows(db: D1Database, userId: string): Promise<WalletRow[]> {
  const { results } = await db
    .prepare(
      `SELECT card_id, verification_status, verified_at
       FROM wallet_cards WHERE user_id = ? ORDER BY created_at ASC`,
    )
    .bind(userId)
    .all<WalletRow>()

  return results
}

/**
 * A wallet with its cards resolved and scored.
 *
 * Retired cards are included on purpose, the same way /preview treats them:
 * someone holding a card the catalog has since dropped should not silently lose
 * it, or the points it was worth.
 */
export async function getWallet(db: D1Database, userId: string): Promise<StoredWallet> {
  const rows = await listWalletRows(db, userId)
  const ids = rows.map((row) => row.card_id)

  if (ids.length === 0) {
    return { cards: [], score: scoreWallet([], []) }
  }

  const { cards } = await listCards(db, {
    ids,
    includeInactive: true,
    // Resolution, not discovery: a card already in a wallet must resolve even
    // with no BIN prefixes on file.
    includeUnselectable: true,
    limit: ids.length,
    offset: 0,
  })

  const byId = new Map(cards.map((card) => [card.id, card]))
  const walletCards: WalletCard[] = []

  // Driven by the wallet rows rather than the returned cards, so the order a
  // person added them survives -- listCards sorts by bank and name.
  for (const row of rows) {
    const card = byId.get(row.card_id)
    if (!card) continue

    walletCards.push({
      card: toPublicCard(card),
      verificationStatus: row.verification_status,
      verifiedAt: row.verified_at,
    })
  }

  return { cards: walletCards, score: scoreWallet(cards, ids) }
}

/**
 * Idempotent add. A card already held keeps the verification state it had --
 * re-adding is not a reason to make someone verify again.
 *
 * Nor is removing and re-adding. A row is born carrying whatever
 * card_verifications already proves about this person and this card, because
 * the payment that earned it is not undone by dropping the row that displayed
 * it. Starting over at 'unverified' left the card stranded: shown as unproved,
 * while the verification module -- reading the evidence, correctly -- refused
 * to sell a second rupee's worth of proof for something already proved.
 */
export async function addCard(db: D1Database, userId: string, cardId: string): Promise<void> {
  const provedAt = (await listProvedCards(db, userId)).get(cardId) ?? null

  await db
    .prepare(
      `INSERT INTO wallet_cards (user_id, card_id, verification_status, verified_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, card_id) DO NOTHING`,
    )
    .bind(userId, cardId, provedAt === null ? 'unverified' : 'verified', provedAt)
    .run()
}

export async function removeCard(db: D1Database, userId: string, cardId: string): Promise<void> {
  await db
    .prepare('DELETE FROM wallet_cards WHERE user_id = ? AND card_id = ?')
    .bind(userId, cardId)
    .run()
}

/**
 * Records what a verification came to, for one card in one person's wallet.
 *
 * Called both by the verification module, which has just watched Razorpay
 * decide, and by PATCH /v1/wallet/cards/:cardId, which takes the client's word
 * for it -- the trade-off that comes with the flow still living partly in the
 * browser.
 *
 * A proved card is the one thing neither caller may undo. Evidence outranks
 * whoever is talking: a tab that still believes a card needs verifying will
 * paint it 'pending', fail on the 409 the verification module answers with, and
 * write 'failed' back -- and that is precisely the disagreement between the two
 * tables that strands a card. A second attempt landing 'mismatched' after a
 * first one succeeded is the same case seen from the server's side.
 *
 * `verified_at` is set here rather than accepted from the client: a timestamp
 * is a fact about when the card was proved, and the CHECK constraint requires
 * it to be absent for every status but 'verified'. COALESCE keeps the date the
 * proof already carries, so re-affirming a verification cannot re-date it.
 */
export async function setVerificationStatus(
  db: D1Database,
  userId: string,
  cardId: string,
  status: VerificationStatus,
): Promise<boolean> {
  const effective =
    status === 'verified' || !(await listProvedCards(db, userId)).has(cardId)
      ? status
      : 'verified'

  const verifiedAt = effective === 'verified' ? `COALESCE(verified_at, ${NOW})` : 'NULL'

  const result = await db
    .prepare(
      `UPDATE wallet_cards
       SET verification_status = ?, verified_at = ${verifiedAt}, updated_at = ${NOW}
       WHERE user_id = ? AND card_id = ?`,
    )
    .bind(effective, userId, cardId)
    .run()

  return (result.meta.changes ?? 0) > 0
}

/**
 * Folds a visitor's local picks into their stored wallet at sign-in.
 *
 * DO NOTHING rather than an upsert: a card already on the server keeps its
 * verification state, so a fresh browser cannot downgrade a card the account
 * verified elsewhere. Local-only cards arrive unverified regardless of what the
 * browser believed, because verifying is per-account, not per-device.
 */
export async function mergeCards(
  db: D1Database,
  userId: string,
  cardIds: string[],
): Promise<StoredWallet> {
  if (cardIds.length > 0) {
    // One read for the whole batch, then the same rule addCard follows: a card
    // this account has proved arrives proved, whatever the browser believed.
    const proved = await listProvedCards(db, userId)

    await db.batch(
      cardIds.map((cardId) => {
        const provedAt = proved.get(cardId) ?? null
        return db
          .prepare(
            `INSERT INTO wallet_cards (user_id, card_id, verification_status, verified_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, card_id) DO NOTHING`,
          )
          .bind(userId, cardId, provedAt === null ? 'unverified' : 'verified', provedAt)
      }),
    )
  }

  return getWallet(db, userId)
}

/**
 * How many of a person's cards are verified.
 *
 * Exported for the users module, which gates claiming a handle on there being
 * at least one -- it cannot read wallet_cards itself, and counting in SQL beats
 * resolving and scoring a whole wallet to ask a yes/no question.
 */
export async function countVerifiedCards(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM wallet_cards
       WHERE user_id = ? AND verification_status = 'verified'`,
    )
    .bind(userId)
    .first<{ n: number }>()

  return row?.n ?? 0
}

/**
 * The verified half of a wallet, resolved and scored on its own.
 *
 * A public profile shows only what somebody has proved they hold, and it scores
 * only that -- which is what the frontend already does, so this moves the rule
 * server-side rather than inventing it.
 *
 * Retired and BIN-less cards resolve here for the same reason they do in
 * getWallet: holding a card the catalog dropped should not quietly cost the
 * points it was worth.
 */
export async function getVerifiedWallet(db: D1Database, userId: string): Promise<StoredWallet> {
  const rows = (await listWalletRows(db, userId)).filter(
    (row) => row.verification_status === 'verified',
  )
  const ids = rows.map((row) => row.card_id)

  if (ids.length === 0) {
    return { cards: [], score: scoreWallet([], []) }
  }

  const { cards } = await listCards(db, {
    ids,
    includeInactive: true,
    includeUnselectable: true,
    limit: ids.length,
    offset: 0,
  })

  const byId = new Map(cards.map((card) => [card.id, card]))
  const walletCards: WalletCard[] = []

  // Driven by the rows, so the order they were added survives.
  for (const row of rows) {
    const card = byId.get(row.card_id)
    if (!card) continue

    walletCards.push({
      card: toPublicCard(card),
      verificationStatus: row.verification_status,
      verifiedAt: row.verified_at,
    })
  }

  return { cards: walletCards, score: scoreWallet(cards, ids) }
}
