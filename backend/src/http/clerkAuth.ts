import { verifyToken } from '@clerk/backend'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import type { AppEnv, AuthUser } from '../env'
import { upsertUserByClerkId } from '../modules/users/queries'
import { ApiError } from './errors'

/**
 * Session-token auth, the counterpart to adminAuth's shared secret. That guards
 * writes to the catalog; this identifies the person a wallet belongs to.
 *
 * Two middlewares over one verifier, because the cards API has to serve both
 * audiences from a single route: `requireUser` rejects anonymous callers,
 * `optionalUser` lets them through unidentified.
 */

function bearerToken(c: Context<AppEnv>): string | null {
  const header = c.req.header('Authorization')
  if (!header) return null

  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

/**
 * Verified claims in, our user row out. The upsert here is the backstop for the
 * Clerk webhook: a user whose `user.created` never arrived still gets a row on
 * their first API call, so no request fails for want of one.
 */
async function resolveUser(c: Context<AppEnv>, token: string): Promise<AuthUser> {
  const secretKey = c.env.CLERK_SECRET_KEY
  if (!secretKey) {
    // Fails closed, like adminAuth: a half-configured deploy rejects callers
    // rather than treating everyone as signed in.
    throw ApiError.unauthorized('Session auth is not configured on this deployment.')
  }

  let claims: Awaited<ReturnType<typeof verifyToken>>
  try {
    claims = await verifyToken(token, {
      // Signatures are checked against Clerk's JWKS, which the SDK caches per
      // isolate for five minutes and re-fetches the moment a token arrives
      // bearing a key id it has not seen. That is what makes a key rotation a
      // non-event; the static PEM this replaced would have 401'd every request
      // until someone pasted a new one in by hand.
      secretKey,
      // Pins the token to our own frontends. Without it a token minted for any
      // other Clerk app on the same instance would verify here.
      authorizedParties: c.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()),
    })
  } catch (err) {
    // The reason is deliberately not echoed back: expired, malformed and
    // wrong-issuer are all "sign in again" to a client. It does go to the logs,
    // though -- without this line a misconfigured secret key and an ordinary
    // expired token are the same opaque 401, which is a bad afternoon.
    console.error('Session token rejected', err)
    throw ApiError.unauthorized('A valid session token is required.')
  }

  const user = await upsertUserByClerkId(c.env.DB, {
    clerkId: claims.sub,
    email: readClaim(claims, 'email'),
    name: readClaim(claims, 'name') ?? readClaim(claims, 'full_name'),
    imageUrl: readClaim(claims, 'image_url') ?? readClaim(claims, 'picture'),
  })

  return { id: user.id, clerkId: claims.sub }
}

/**
 * Claims beyond `sub` depend on how the JWT template is configured, so each is
 * read defensively rather than trusted to be a string.
 */
function readClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 401s anonymous callers. Everything that touches a wallet uses this. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c)
  if (!token) throw ApiError.unauthorized('A valid session token is required.')

  c.set('user', await resolveUser(c, token))
  await next()
})

/**
 * Identifies the caller when it can and shrugs when it cannot, so one route can
 * answer both the public catalog and a signed-in caller's view of it.
 *
 * A present-but-invalid token is still rejected. Silently downgrading it to
 * anonymous would turn an expired session into a confusingly empty wallet
 * rather than a prompt to sign in again.
 */
export const optionalUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c)
  if (token) c.set('user', await resolveUser(c, token))
  await next()
})
