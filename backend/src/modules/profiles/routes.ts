import { Hono } from 'hono'
import type { AppEnv } from '../../env'
import { ApiError } from '../../http/errors'
import { getUserByHandle } from '../users/queries'
import { HANDLE_PATTERN } from '../users/userTypes'
import { getVerifiedWallet } from '../wallet/queries'
import { toPublicProfile } from './profileTypes'

/**
 * The public face of a wallet, and the only unauthenticated read of anybody's
 * data in this API.
 *
 * A module of its own rather than a route on /v1/users, whose docstring says it
 * never returns anyone else's row -- and it still does not. What this returns
 * is a projection, and keeping it here is what makes that distinction something
 * you can see from the URL rather than something you have to trust.
 *
 * There is no queries.ts: this module owns no tables. It calls
 * users.getUserByHandle and wallet.getVerifiedWallet, per the rule in
 * README.md that no module writes SQL against another's tables.
 */
export const profileRoutes = new Hono<AppEnv>()

profileRoutes.get('/:handle', async (c) => {
  const handle = c.req.param('handle').trim().toLowerCase()

  // A malformed handle cannot match a row -- the CHECK forbids storing one --
  // so this is a 404 rather than a 400. There is nothing to correct: no such
  // profile exists and none ever could.
  if (!HANDLE_PATTERN.test(handle)) throw ApiError.notFound(`Profile '${handle}'`)

  const user = await getUserByHandle(c.env.DB, handle)
  // A deactivated user is gone as far as the public is concerned. Their wallet
  // is intact and comes back with them if Clerk un-deletes them.
  if (!user || !user.isActive) throw ApiError.notFound(`Profile '${handle}'`)

  const wallet = await getVerifiedWallet(c.env.DB, user.id)
  return c.json(toPublicProfile(user.handle ?? handle, wallet))
})
