import type { ClerkIdentity } from './userTypes'

/**
 * Mirrors the CHECK constraints in 0007_create_users.sql. Change one, change
 * the other -- the database is the backstop, this is the readable error.
 *
 * Unlike the other modules' validators there is no client body to police here:
 * every field arrives from Clerk, already verified. What this guards against is
 * a value too long for the column, which would otherwise surface as an opaque
 * constraint failure mid-request.
 */

const MAX_CLERK_ID = 120
const MAX_EMAIL = 320
const MAX_NAME = 120
const MAX_IMAGE_URL = 2048

function clamp(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * Returns null when the identity is unusable -- which in practice means Clerk
 * sent no subject, since everything else is optional.
 */
export function normalizeIdentity(identity: ClerkIdentity): ClerkIdentity | null {
  const clerkId = clamp(identity.clerkId, MAX_CLERK_ID)
  if (!clerkId) return null

  return {
    clerkId,
    email: clamp(identity.email, MAX_EMAIL),
    name: clamp(identity.name, MAX_NAME),
    imageUrl: clamp(identity.imageUrl, MAX_IMAGE_URL),
  }
}
