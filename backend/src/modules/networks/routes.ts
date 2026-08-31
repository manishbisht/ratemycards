import { Hono } from 'hono'
import { adminAuth } from '../../http/adminAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import { parseBool, parseLimit, parseOffset } from '../../http/params'
import type { AppEnv } from '../../env'
import {
  createNetwork,
  deactivateNetwork,
  getNetwork,
  listNetworks,
  updateNetwork,
} from './queries'
import { validateNetworkInput, validateNetworkPatch } from './validate'

/**
 * Admin-only throughout, reads included -- which departs from /v1/banks and
 * /v1/cards, where GET is public.
 *
 * The reason is that this resource has no public consumer: the frontend calls
 * only /v1/cards, /v1/wallet* and /v1/verifications*, takes the issuer name
 * from the card's own `issuer` field, and shows no network anywhere. The admin
 * panel is the sole reader. Publishing it later, if a network badge on a card
 * ever wants it, is a one-line change; un-publishing it once a client depends
 * on it is not.
 *
 * Five handlers, five adminAuth.
 */
export const networkRoutes = new Hono<AppEnv>()

networkRoutes.get('/', adminAuth, async (c) => {
  const query = c.req.query('q')?.trim()
  const { networks, total } = await listNetworks(c.env.DB, {
    q: query ? query : undefined,
    includeInactive: parseBool(c.req.query('includeInactive')),
    limit: parseLimit(c.req.query('limit')),
    offset: parseOffset(c.req.query('offset')),
  })
  return c.json({ data: networks, total })
})

networkRoutes.get('/:id', adminAuth, async (c) => {
  const id = c.req.param('id')
  const network = await getNetwork(c.env.DB, id)
  if (!network) throw ApiError.notFound(`Network '${id}'`)
  return c.json(network)
})

networkRoutes.post('/', adminAuth, async (c) => {
  const result = validateNetworkInput(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const network = await createNetwork(c.env.DB, result.value)
  c.header('Location', `/v1/networks/${network.id}`)
  return c.json(network, 201)
})

networkRoutes.patch('/:id', adminAuth, async (c) => {
  const result = validateNetworkPatch(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  return c.json(await updateNetwork(c.env.DB, c.req.param('id'), result.value))
})

networkRoutes.delete('/:id', adminAuth, async (c) => {
  await deactivateNetwork(c.env.DB, c.req.param('id'))
  return c.body(null, 204)
})
