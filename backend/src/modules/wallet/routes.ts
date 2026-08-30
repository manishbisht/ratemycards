import { Hono } from 'hono'
import { requireUser } from '../../http/clerkAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import type { AppEnv, AuthUser } from '../../env'
import { getCard, listCards } from '../cards/queries'
import {
  addCard,
  getWallet,
  mergeCards,
  removeCard,
  setVerificationStatus,
} from './queries'
import { scoreWallet } from './walletTypes'
import { validateCardIdParam, validateCardIds, validateVerificationStatus } from './validate'

export const walletRoutes = new Hono<AppEnv>()

/**
 * /preview is public and stateless -- an anonymous visitor still gets a score.
 * Everything else is a stored wallet and goes through requireUser. Applied per
 * route rather than as a prefix, matching how adminAuth is used elsewhere: the
 * count of guards here must equal the number of handlers that touch a wallet.
 */

/**
 * Scores a set of cards without storing anything. Safe to call on every
 * keystroke, and the single source of the formula.
 */
walletRoutes.post('/preview', async (c) => {
  const result = validateCardIds(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const ids = result.value
  if (ids.length === 0) {
    return c.json(scoreWallet([], []))
  }

  // Retired cards still score: someone holding one should not silently lose
  // points because the catalog moved on.
  const { cards } = await listCards(c.env.DB, {
    ids,
    includeInactive: true,
    limit: ids.length,
    offset: 0,
  })

  return c.json(scoreWallet(cards, ids))
})

/** The signed-in caller's stored wallet, cards resolved and scored. */
walletRoutes.get('/', requireUser, async (c) => {
  return c.json(await getWallet(c.env.DB, callerId(c.get('user'))))
})

/**
 * Folds the cards a visitor picked before signing in into their stored wallet.
 * The union is the point: someone who picked cards on a phone and already has a
 * wallet from a laptop should end up with both, never one overwriting the other.
 */
walletRoutes.post('/merge', requireUser, async (c) => {
  const result = validateCardIds(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const userId = callerId(c.get('user'))
  // Unknown ids are dropped rather than rejected: a stale localStorage blob
  // naming a card the catalog no longer has should not block the whole merge.
  const known = await knownCardIds(c.env.DB, result.value)

  return c.json(await mergeCards(c.env.DB, userId, known))
})

walletRoutes.put('/cards/:cardId', requireUser, async (c) => {
  const cardId = requireCardId(c.req.param('cardId'))
  const userId = callerId(c.get('user'))

  // Checked rather than left to the foreign key, which would surface as a 500.
  const card = await getCard(c.env.DB, cardId)
  if (!card) throw ApiError.notFound(`Card '${cardId}'`)

  await addCard(c.env.DB, userId, cardId)
  return c.json(await getWallet(c.env.DB, userId))
})

walletRoutes.delete('/cards/:cardId', requireUser, async (c) => {
  const cardId = requireCardId(c.req.param('cardId'))

  // Idempotent: removing a card that is not held is the state the caller asked
  // for, so it is a 204 rather than a 404.
  await removeCard(c.env.DB, callerId(c.get('user')), cardId)
  return c.body(null, 204)
})

/**
 * Records how a card's verification came out. The server does not run the check
 * itself yet, so this takes the client's word for the caller's own wallet.
 */
walletRoutes.patch('/cards/:cardId', requireUser, async (c) => {
  const cardId = requireCardId(c.req.param('cardId'))
  const userId = callerId(c.get('user'))

  const result = validateVerificationStatus(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const updated = await setVerificationStatus(c.env.DB, userId, cardId, result.value)
  if (!updated) throw ApiError.notFound(`Card '${cardId}' in your wallet`)

  return c.json(await getWallet(c.env.DB, userId))
})

/**
 * requireUser has already run wherever these are called, so a missing user is a
 * wiring mistake rather than an anonymous request -- but the types say optional,
 * and silently defaulting would hand one person another's wallet.
 */
function callerId(user: AuthUser | undefined): string {
  if (!user) throw ApiError.unauthorized('A valid session token is required.')
  return user.id
}

function requireCardId(raw: string): string {
  const result = validateCardIdParam(raw)
  if (!result.ok) throw ApiError.validation(result.errors)
  return result.value
}

async function knownCardIds(db: D1Database, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []

  const { cards } = await listCards(db, {
    ids,
    includeInactive: true,
    limit: ids.length,
    offset: 0,
  })
  return cards.map((card) => card.id)
}
