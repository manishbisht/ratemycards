import { bearerAuth } from 'hono/bearer-auth'
import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../env'
import { ApiError } from './errors'

/**
 * Guards every mutation. The comparison itself is delegated to hono/bearer-auth,
 * which is already timing-safe -- do not hand-roll it.
 *
 * Fails closed: an unset ADMIN_TOKEN rejects writes rather than waving them
 * through, so a half-configured deploy is never writable.
 */
export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = c.env.ADMIN_TOKEN
  if (!token) {
    throw ApiError.unauthorized('Admin access is not configured on this deployment.')
  }
  return (bearerAuth({ token }) as MiddlewareHandler<AppEnv>)(c, next)
})
