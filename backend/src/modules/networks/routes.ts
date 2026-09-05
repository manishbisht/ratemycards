import { Hono } from 'hono'
import { adminAuth } from '../../http/adminAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import { MAX_LIMIT, parseBool, parseLimit, parseOffset } from '../../http/params'
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
 * The reason was that this resource had no public consumer: the frontend called
 * only /v1/cards, /v1/wallet* and /v1/verifications*, took the issuer name from
 * the card's own `issuer` field, and showed no network anywhere.
 *
 * `GET /options` is the one exception, and the change this docstring predicted.
 * The card-request form has to ask which network somebody's card runs on, and
 * the alternative -- a hardcoded list of eight codes in the client -- would put
 * a second copy of server truth in the bundle. It publishes the code and the
 * display name and NOTHING ELSE: not the id, which never leaves the server, and
 * not binRules, which is the list a verification matches against.
 *
 * Six handlers, five adminAuth.
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

/**
 * The networks a person can say their card runs on. Public, and deliberately
 * the narrowest possible projection -- see the note above.
 *
 * Declared before `/:id` so the literal path is never read as an id.
 */
networkRoutes.get('/options', async (c) => {
  const { networks } = await listNetworks(c.env.DB, {
    includeInactive: false,
    limit: MAX_LIMIT,
    offset: 0,
  })

  return c.json({
    data: networks.map((network) => ({ code: network.code, name: network.name })),
    total: networks.length,
  })
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
