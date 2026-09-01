/**
 * `Env` itself is generated into worker-configuration.d.ts by `npm run typegen`
 * -- rerun it whenever a binding is added to wrangler.jsonc. This alias is the
 * shape Hono wants, so routes can be typed `Hono<AppEnv>`.
 */

/**
 * The caller behind a Clerk session token. `id` is ours, not Clerk's: handlers
 * and foreign keys only ever see a local `user_...` id, so nothing downstream
 * is coupled to the identity provider.
 */
export type AuthUser = {
  id: string
  clerkId: string
  /**
   * Read from the user's own row, never from a claim: Clerk is the identity
   * provider, not the authority on who may edit the catalog.
   */
  isAdmin: boolean
}

export type AppEnv = {
  Bindings: Env
  /**
   * Set by the middlewares in http/clerkAuth.ts. Optional because
   * `optionalUser` leaves it unset for anonymous callers, which is exactly what
   * makes the cards API serve both audiences from one route.
   */
  Variables: {
    user?: AuthUser
  }
}
