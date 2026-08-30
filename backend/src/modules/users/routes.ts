import { Hono } from 'hono'
import type { AppEnv } from '../../env'
import { requireUser } from '../../http/clerkAuth'
import { ApiError } from '../../http/errors'
import { getUserByClerkId } from './queries'

export const userRoutes = new Hono<AppEnv>()

/**
 * The caller's own row. There is deliberately no endpoint that returns anyone
 * else's: nothing in the product needs it, and not building it means there is
 * no per-user authorisation to get wrong.
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
