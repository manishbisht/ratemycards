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
  /** The public profile name, or null until one is claimed. */
  handle: string | null
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

/**
 * Mirrors the CHECK in migration 0014 and HANDLE_PATTERN in the frontend's
 * data/handles.ts. Change one, change all three.
 */
export const HANDLE_MIN = 3
export const HANDLE_MAX = 20
export const HANDLE_PATTERN = new RegExp(`^[a-z0-9_]{${HANDLE_MIN},${HANDLE_MAX}}$`)

/**
 * Not a routing concern -- profiles live under `#/u/`, so `admin` as a handle
 * would resolve perfectly well. The point is that `@admin` on a page about
 * somebody's money reads as authority nobody granted.
 */
export const RESERVED_HANDLES: readonly string[] = ['admin', 'api', 'www', 'u', 'health']

export function isReservedHandle(value: string): boolean {
  return RESERVED_HANDLES.includes(value)
}
