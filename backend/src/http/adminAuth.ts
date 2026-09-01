import { bearerAuth } from 'hono/bearer-auth'
import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../env'
import { bearerToken, looksLikeSessionToken, resolveUser } from './clerkAuth'
import { ApiError } from './errors'

/**
 * Guards every mutation, and accepts either of two credentials.
 *
 * WHY TWO. The shared ADMIN_TOKEN is unattributable and cannot reach a browser:
 * every VITE_* value is baked into the public bundle at build time, so shipping
 * the secret to the admin panel would publish it. The panel therefore
 * authenticates as a person -- an ordinary Clerk session whose user row carries
 * is_admin -- while the token stays for curl, scripts and the test suite.
 *
 * WHY ROUTE ON SHAPE. A Clerk session token is a three-segment JWS; a shared
 * secret is not. Discriminating on that keeps the token path *byte-identical*
 * to what it was, which matters more than it looks: hono/bearer-auth hashes
 * both sides before comparing, so a wrong-length token is a 401 rather than the
 * 500 that workerd's timingSafeEqual would throw, and a header missing the
 * `Bearer` scheme is RFC 6750's 400 invalid_request rather than a 401. Both are
 * pinned by test/auth.test.ts. Do not hand-roll the comparison.
 *
 * The shape test is only a routing hint -- `verifyToken` is what decides whether
 * a JWT-shaped credential is genuine -- and it cannot collide with a correctly
 * generated ADMIN_TOKEN, which README's recipe makes 43 base64url characters
 * with no dots. See looksLikeSessionToken for the rotation constraint that
 * implies.
 *
 * ONE ASYMMETRY TO KNOW ABOUT. On the shared-secret path `c.get('user')` stays
 * `undefined`: the token identifies nobody. Anything later that wants to record
 * *who* made a change has to handle "authenticated as the shared secret". The
 * `user?:` on AppEnv['Variables'] already forces that check.
 */
export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const presented = bearerToken(c)

  if (presented !== null && looksLikeSessionToken(presented)) {
    // Throws 401 on a token that does not verify. Also upserts, which is what
    // reconciles the ADMIN_EMAILS allowlist -- so the very first admin sign-in
    // is granted and admitted in the same request.
    const user = await resolveUser(c, presented)

    if (!user.isAdmin) {
      // 403, not 401: this session is valid and signing in again will not help.
      throw ApiError.forbidden('This account does not have admin access.')
    }

    c.set('user', user)
    return next()
  }

  const token = c.env.ADMIN_TOKEN
  if (!token) {
    // Fails this branch closed -- an unset ADMIN_TOKEN must not turn into a
    // wildcard. The session branch above is unaffected, so a deployment can
    // legitimately run with no shared secret at all.
    throw ApiError.unauthorized('Admin access is not configured on this deployment.')
  }

  return (bearerAuth({ token }) as MiddlewareHandler<AppEnv>)(c, next)
})
