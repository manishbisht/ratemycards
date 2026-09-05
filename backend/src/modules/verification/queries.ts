import { ApiError } from '../../http/errors'
import { generateVerificationId } from './verificationTypes'
import type {
  ReleaseState,
  VerificationAttempt,
  VerificationAttemptStatus,
} from './verificationTypes'
import type { RazorpayCard } from './razorpay'

/**
 * This module owns `card_verifications` and nothing else. Reading a card's
 * networks goes through `cards.listCardNetworks`, and flipping a wallet card's
 * status goes through `wallet.setVerificationStatus` -- neither table is touched
 * with SQL from here.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

type AttemptRow = {
  id: string
  user_id: string
  card_id: string
  razorpay_order_id: string
  razorpay_payment_id: string | null
  amount: number
  status: VerificationAttemptStatus
  release_state: ReleaseState
}

function toAttempt(row: AttemptRow): VerificationAttempt {
  return {
    id: row.id,
    userId: row.user_id,
    cardId: row.card_id,
    orderId: row.razorpay_order_id,
    paymentId: row.razorpay_payment_id,
    amount: row.amount,
    status: row.status,
    releaseState: row.release_state,
  }
}

export async function createAttempt(
  db: D1Database,
  input: { userId: string; cardId: string; orderId: string; amount: number },
): Promise<VerificationAttempt> {
  const id = generateVerificationId()

  await db
    .prepare(
      `INSERT INTO card_verifications (id, user_id, card_id, razorpay_order_id, amount)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.userId, input.cardId, input.orderId, input.amount)
    .run()

  return {
    id,
    userId: input.userId,
    cardId: input.cardId,
    orderId: input.orderId,
    paymentId: null,
    amount: input.amount,
    status: 'created',
    releaseState: 'pending',
  }
}

/** Scoped to the caller: one person cannot confirm another's attempt. */
export async function getAttempt(
  db: D1Database,
  id: string,
  userId: string,
): Promise<VerificationAttempt | null> {
  const row = await db
    .prepare(
      `SELECT id, user_id, card_id, razorpay_order_id, razorpay_payment_id,
              amount, status, release_state
       FROM card_verifications WHERE id = ? AND user_id = ?`,
    )
    .bind(id, userId)
    .first<AttemptRow>()

  return row ? toAttempt(row) : null
}

/**
 * Records the outcome and claims the payment id in one statement.
 *
 * The UNIQUE index on `razorpay_payment_id` is what stops one successful rupee
 * being replayed against a second card, so a collision here is a replay
 * attempt, not a glitch -- it becomes a 409 rather than a 500.
 */
export async function settleAttempt(
  db: D1Database,
  id: string,
  input: {
    paymentId: string
    status: VerificationAttemptStatus
    card?: RazorpayCard | null
    reason?: string | null
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE card_verifications
         SET razorpay_payment_id = ?, status = ?, failure_reason = ?,
             card_network = ?, card_last4 = ?, card_type = ?, card_issuer = ?,
             updated_at = ${NOW}
         WHERE id = ?`,
      )
      .bind(
        input.paymentId,
        input.status,
        input.reason ?? null,
        input.card?.network ?? null,
        input.card?.last4 ?? null,
        input.card?.type ?? null,
        input.card?.issuer ?? null,
        id,
      )
      .run()
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      throw ApiError.conflict('That payment has already been used to verify a card.')
    }
    throw err
  }
}

export async function recordRelease(
  db: D1Database,
  id: string,
  state: ReleaseState,
): Promise<void> {
  await db
    .prepare(`UPDATE card_verifications SET release_state = ?, updated_at = ${NOW} WHERE id = ?`)
    .bind(state, id)
    .run()
}

/** Whether this person has already proved this card, so a repeat is a no-op. */
export async function hasVerified(
  db: D1Database,
  userId: string,
  cardId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM card_verifications
       WHERE user_id = ? AND card_id = ? AND status = 'verified' LIMIT 1`,
    )
    .bind(userId, cardId)
    .first()

  return row !== null
}

/**
 * When each of this person's proved cards was proved.
 *
 * This table is the durable half of a verification; `wallet_cards` only
 * reflects it. The wallet asks this whenever it writes that reflection --
 * creating a row, or being told a status by a client -- because the reflection
 * is droppable and the fact is not. Remove a verified card and the row goes
 * with it; add it back and the row has to be rebuilt from the evidence rather
 * than started over at 'unverified'.
 *
 * MIN, so a card carries the date it was first proved. One verified attempt per
 * card is all `hasVerified` lets through, but the aggregate has to mean
 * something for the rows already written before that guard existed.
 */
export async function listProvedCards(
  db: D1Database,
  userId: string,
): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      `SELECT card_id, MIN(updated_at) AS proved_at
       FROM card_verifications
       WHERE user_id = ? AND status = 'verified'
       GROUP BY card_id`,
    )
    .bind(userId)
    .all<{ card_id: string; proved_at: string }>()

  return new Map(results.map((row) => [row.card_id, row.proved_at]))
}
