import { Hono } from 'hono'
import { ApiError, readJsonBody } from '../../http/errors'
import type { AppEnv } from '../../env'
import { listCards } from '../cards/queries'
import { scoreWallet } from './walletTypes'
import { validateCardIds } from './validate'

export const walletRoutes = new Hono<AppEnv>()

/**
 * Scores a set of cards without storing anything. The wallet lives in the
 * client until accounts exist, so this is a pure function over card ids --
 * safe to call on every keystroke, and the single source of the formula.
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
