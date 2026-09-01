import { generateId, idPattern } from '../../http/ids'

export const USER_ID_PREFIX = 'user'
export const USER_ID_PATTERN = idPattern(USER_ID_PREFIX)

export function generateUserId(): string {
  return generateId(USER_ID_PREFIX)
}

/**
 * The public user. Only ever the caller's own row -- there is no endpoint that
 * hands one user another's, so nothing here needs redacting per-audience.
 */
export type User = {
  id: string
  email: string | null
  name: string | null
  imageUrl: string | null
  isActive: boolean
  /**
   * Whether this person may drive the admin panel. Granted from the
   * ADMIN_EMAILS allowlist, never from anything the client sends.
   */
  isAdmin: boolean
}

/**
 * What Clerk tells us about a person, from either a session token's claims or a
 * webhook payload. Everything but the id is optional: an SSO connection can
 * yield a user with no email, and a token carries only the claims the JWT
 * template was configured to include.
 */
export type ClerkIdentity = {
  clerkId: string
  email?: string | null
  name?: string | null
  imageUrl?: string | null
}
