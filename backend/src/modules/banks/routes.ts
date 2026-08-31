import { Hono } from 'hono'
import { adminAuth } from '../../http/adminAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import { parseBool, parseLimit, parseOffset } from '../../http/params'
import type { AppEnv } from '../../env'
import { listCards } from '../cards/queries'
import { toPublicCard } from '../cards/cardTypes'
import { createBank, deactivateBank, getBank, listBanks, updateBank } from './queries'
import { validateBankInput, validateBankPatch } from './validate'

export const bankRoutes = new Hono<AppEnv>()

bankRoutes.get('/', async (c) => {
  const query = c.req.query('q')?.trim()
  const { banks, total } = await listBanks(c.env.DB, {
    q: query ? query : undefined,
    includeInactive: parseBool(c.req.query('includeInactive')),
    limit: parseLimit(c.req.query('limit')),
    offset: parseOffset(c.req.query('offset')),
  })
  return c.json({ data: banks, total })
})

bankRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const bank = await getBank(c.env.DB, id)
  if (!bank) throw ApiError.notFound(`Bank '${id}'`)
  return c.json(bank)
})

/** A bank has many cards; this is the navigable side of that relationship. */
bankRoutes.get('/:id/cards', async (c) => {
  const id = c.req.param('id')
  if (!(await getBank(c.env.DB, id))) throw ApiError.notFound(`Bank '${id}'`)

  const { cards, total } = await listCards(c.env.DB, {
    bankId: id,
    includeInactive: parseBool(c.req.query('includeInactive')),
    includeUnselectable: parseBool(c.req.query('includeUnselectable')),
    limit: parseLimit(c.req.query('limit')),
    offset: parseOffset(c.req.query('offset')),
  })
  return c.json({ data: cards.map(toPublicCard), total })
})

bankRoutes.post('/', adminAuth, async (c) => {
  const result = validateBankInput(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const bank = await createBank(c.env.DB, result.value)
  c.header('Location', `/v1/banks/${bank.id}`)
  return c.json(bank, 201)
})

bankRoutes.patch('/:id', adminAuth, async (c) => {
  const result = validateBankPatch(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  return c.json(await updateBank(c.env.DB, c.req.param('id'), result.value))
})

bankRoutes.delete('/:id', adminAuth, async (c) => {
  await deactivateBank(c.env.DB, c.req.param('id'))
  return c.body(null, 204)
})
