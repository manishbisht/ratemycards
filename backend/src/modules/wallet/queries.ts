import { listCards } from '../cards/queries'
import { toPublicCard } from '../cards/cardTypes'
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
 */
export async function addCard(db: D1Database, userId: string, cardId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO wallet_cards (user_id, card_id) VALUES (?, ?)
       ON CONFLICT(user_id, card_id) DO NOTHING`,
    )
    .bind(userId, cardId)
    .run()
}

export async function removeCard(db: D1Database, userId: string, cardId: string): Promise<void> {
  await db
    .prepare('DELETE FROM wallet_cards WHERE user_id = ? AND card_id = ?')
    .bind(userId, cardId)
    .run()
}

/**
 * Records what the client says the verification came to. The server does not
 * yet run the check itself, so this trusts the caller for their own wallet --
 * the trade-off that comes with the flow still living in the browser.
 *
 * `verified_at` is set here rather than accepted from the client: a timestamp
 * is a fact about when the server was told, and the CHECK constraint requires
 * it to be absent for every status but 'verified'.
 */
export async function setVerificationStatus(
  db: D1Database,
  userId: string,
  cardId: string,
  status: VerificationStatus,
): Promise<boolean> {
  const verifiedAt = status === 'verified' ? NOW : 'NULL'

  const result = await db
    .prepare(
      `UPDATE wallet_cards
       SET verification_status = ?, verified_at = ${verifiedAt}, updated_at = ${NOW}
       WHERE user_id = ? AND card_id = ?`,
    )
    .bind(status, userId, cardId)
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
    await db.batch(
      cardIds.map((cardId) =>
        db
          .prepare(
            `INSERT INTO wallet_cards (user_id, card_id) VALUES (?, ?)
             ON CONFLICT(user_id, card_id) DO NOTHING`,
          )
          .bind(userId, cardId),
      ),
    )
  }

  return getWallet(db, userId)
}
