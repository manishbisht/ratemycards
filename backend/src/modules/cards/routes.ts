import { Hono } from 'hono'
import { adminAuth } from '../../http/adminAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import { parseBool, parseIds, parseLimit, parseNonNegativeInt, parseOffset } from '../../http/params'
import type { AppEnv } from '../../env'
import { toPublicCard } from './cardTypes'
import { getCardScores, replaceCardScores } from '../scoring/queries'
import { validateScoresBody } from '../scoring/validate'
import { createCard, deactivateCard, getCard, listCards, updateCard } from './queries'
import { validateCardInput, validateCardPatch } from './validate'

export const cardRoutes = new Hono<AppEnv>()

/**
 * Reads are public; every mutation goes through adminAuth. Applying it per
 * route rather than as a path prefix keeps it greppable -- the count of
 * `adminAuth` here must equal the number of write handlers.
 */

cardRoutes.get('/', async (c) => {
  const query = c.req.query('q')?.trim()
  const { cards, total } = await listCards(c.env.DB, {
    q: query ? query : undefined,
    bankId: c.req.query('bankId'),
    country: c.req.query('country')?.toUpperCase(),
    maxAnnualFee: parseNonNegativeInt(c.req.query('maxAnnualFee')),
    ids: parseIds(c.req.query('ids')),
    includeInactive: parseBool(c.req.query('includeInactive')),
    limit: parseLimit(c.req.query('limit')),
    offset: parseOffset(c.req.query('offset')),
  })
  return c.json({ data: cards.map(toPublicCard), total })
})

cardRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const card = await getCard(c.env.DB, id)
  if (!card) throw ApiError.notFound(`Card '${id}'`)
  return c.json(toPublicCard(card))
})

/**
 * A card's scores against the rubric, and the rating they derive.
 *
 * Admin-only: this is the raw judgement behind a card, and exposing it would
 * defeat keeping `rating` off the public card. Ratings reach the public only
 * aggregated over a whole wallet, via POST /v1/wallet/preview.
 */
cardRoutes.get('/:id/scores', adminAuth, async (c) => {
  const id = c.req.param('id')
  const card = await getCard(c.env.DB, id)
  if (!card) throw ApiError.notFound(`Card '${id}'`)

  const scores = await getCardScores(c.env.DB, id)
  return c.json({ data: scores, total: scores.length, rating: card.rating })
})

/** Replaces the whole set, so repeated calls cannot accumulate duplicates. */
cardRoutes.put('/:id/scores', adminAuth, async (c) => {
  const id = c.req.param('id')
  if (!(await getCard(c.env.DB, id))) throw ApiError.notFound(`Card '${id}'`)

  const result = validateScoresBody(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  await replaceCardScores(c.env.DB, id, result.value)

  const scores = await getCardScores(c.env.DB, id)
  const updated = await getCard(c.env.DB, id)
  return c.json({ data: scores, total: scores.length, rating: updated?.rating })
})

cardRoutes.post('/', adminAuth, async (c) => {
  const result = validateCardInput(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const card = await createCard(c.env.DB, result.value)
  c.header('Location', `/v1/cards/${card.id}`)
  return c.json(toPublicCard(card), 201)
})

cardRoutes.patch('/:id', adminAuth, async (c) => {
  const result = validateCardPatch(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  return c.json(toPublicCard(await updateCard(c.env.DB, c.req.param('id'), result.value)))
})

cardRoutes.delete('/:id', adminAuth, async (c) => {
  await deactivateCard(c.env.DB, c.req.param('id'))
  return c.body(null, 204)
})
