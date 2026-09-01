import { Hono } from 'hono'
import type { AppEnv } from '../../env'
import { requireUser } from '../../http/clerkAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import { countVerifiedCards } from '../wallet/queries'
import { getUserByClerkId, getUserByHandle, setHandle } from './queries'
import { HANDLE_PATTERN, isReservedHandle } from './userTypes'
import { validateHandleInput } from './validate'

export const userRoutes = new Hono<AppEnv>()

/**
 * The caller's own row. There is deliberately no endpoint that returns anyone
 * else's: a public profile is a *projection*, and it lives in modules/profiles
 * precisely so this stays true.
 */
userRoutes.get('/me', requireUser, async (c) => {
  const auth = c.get('user')
  if (!auth) throw ApiError.unauthorized('A valid session token is required.')

  const user = await getUserByClerkId(c.env.DB, auth.clerkId)
  // requireUser upserts before this runs, so a miss means the row was deleted
  // between the two -- rare, but a 404 says so honestly.
  if (!user) throw ApiError.notFound('Your account')

  return c.json(user)
})

/**
 * Claims a handle, or changes one. Re-sending the handle you already hold is a
 * no-op that succeeds; changing frees the old value, because it is one column.
 *
 * The conflict comes from the unique index inside setHandle rather than from a
 * check here, which is what makes two simultaneous claims safe.
 */
userRoutes.put('/me/handle', requireUser, async (c) => {
  const auth = c.get('user')
  if (!auth) throw ApiError.unauthorized('A valid session token is required.')

  const result = validateHandleInput(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  // The claim screen already refuses to render without a verified card, and
  // says why: a public profile should never exist with nothing behind it. A
  // rule that lives only in the client is not a rule.
  if ((await countVerifiedCards(c.env.DB, auth.id)) === 0) {
    throw ApiError.conflict('Verify at least one card before claiming a handle.')
  }

  return c.json(await setHandle(c.env.DB, auth.id, result.value))
})

/**
 * Whether claiming would succeed. Public, and deliberately not an error for a
 * bad handle: this feeds a tick or a cross beside an input as someone types,
 * and a 400 there would mean showing an error for a half-typed name.
 *
 * It reveals which handles exist, which GET /v1/profiles/:handle already does.
 */
export const handleRoutes = new Hono<AppEnv>()

handleRoutes.get('/:handle', async (c) => {
  const raw = c.req.param('handle').trim().toLowerCase()

  const usable = HANDLE_PATTERN.test(raw) && !isReservedHandle(raw)
  const available = usable && (await getUserByHandle(c.env.DB, raw)) === null

  return c.json({ handle: raw, available })
})
