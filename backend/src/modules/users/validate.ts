import type { ClerkIdentity } from './userTypes'
import { isPlainObject } from '../../http/validators'
import { HANDLE_MAX, HANDLE_MIN, HANDLE_PATTERN, isReservedHandle } from './userTypes'

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

/** Declared per module, matching banks, cards, networks and scoring. */
export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/**
 * The one client-supplied value in this module. Everything else arrives from
 * Clerk already verified, which is why normalizeIdentity above clamps rather
 * than rejects; this one is typed by a person and gets a real 400.
 *
 * Normalises before validating, so `  ArjunK  ` is accepted as `arjunk` rather
 * than rejected for characters the user cannot see.
 */
export function validateHandleInput(body: unknown): Validated<string> {
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  if (typeof body.handle !== 'string') {
    return { ok: false, errors: ['handle is required and must be a string.'] }
  }

  const handle = body.handle.trim().toLowerCase()
  const errors: string[] = []

  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    errors.push(`handle must be ${HANDLE_MIN} to ${HANDLE_MAX} characters.`)
  }
  if (!/^[a-z0-9_]*$/.test(handle)) {
    errors.push('handle may contain only letters, numbers and underscores.')
  }
  // Checked after normalisation, so 'ADMIN' is caught too.
  if (isReservedHandle(handle)) {
    errors.push(`'${handle}' is reserved.`)
  }

  if (errors.length > 0) return { ok: false, errors }

  // Belt and braces: the two rules above should already imply the pattern, and
  // if they ever drift this is what stops a bad value reaching the CHECK.
  if (!HANDLE_PATTERN.test(handle)) {
    return { ok: false, errors: ['handle is not valid.'] }
  }

  return { ok: true, value: handle }
}
