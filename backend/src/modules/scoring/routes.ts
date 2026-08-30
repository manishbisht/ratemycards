import { Hono } from 'hono'
import { adminAuth } from '../../http/adminAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import { parseBool, parseLimit, parseOffset } from '../../http/params'
import type { AppEnv } from '../../env'
import {
  createCriterion,
  deactivateCriterion,
  getCriterion,
  listCriteria,
  updateCriterion,
} from './queries'
import { validateCriterionInput, validateCriterionPatch } from './validate'

/** The rubric itself. A card's scores hang off /v1/cards/:id/scores. */
export const criterionRoutes = new Hono<AppEnv>()

criterionRoutes.get('/', async (c) => {
  const query = c.req.query('q')?.trim()
  const { criteria, total } = await listCriteria(c.env.DB, {
    q: query ? query : undefined,
    includeInactive: parseBool(c.req.query('includeInactive')),
    limit: parseLimit(c.req.query('limit')),
    offset: parseOffset(c.req.query('offset')),
  })
  return c.json({ data: criteria, total })
})

criterionRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const criterion = await getCriterion(c.env.DB, id)
  if (!criterion) throw ApiError.notFound(`Criterion '${id}'`)
  return c.json(criterion)
})

criterionRoutes.post('/', adminAuth, async (c) => {
  const result = validateCriterionInput(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const criterion = await createCriterion(c.env.DB, result.value)
  c.header('Location', `/v1/criteria/${criterion.id}`)
  return c.json(criterion, 201)
})

criterionRoutes.patch('/:id', adminAuth, async (c) => {
  const result = validateCriterionPatch(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  return c.json(await updateCriterion(c.env.DB, c.req.param('id'), result.value))
})

criterionRoutes.delete('/:id', adminAuth, async (c) => {
  await deactivateCriterion(c.env.DB, c.req.param('id'))
  return c.body(null, 204)
})
