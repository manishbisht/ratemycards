export const HANDLE_MIN = 3
export const HANDLE_MAX = 20

/** The shape a `#/u/<handle>` route must match. Mirrors migration 0014. */
export const HANDLE_PATTERN = new RegExp(`^[a-z0-9_]{${HANDLE_MIN},${HANDLE_MAX}}$`)

/**
 * Whether a handle *could* be claimed, on shape alone.
 *
 * Availability is no longer answered here. It used to be, against five names
 * transcribed from the design, which meant two people could both be told a
 * handle was free. The server owns that question now -- see
 * checkHandleAvailability -- and this only decides whether it is worth asking.
 */
export type HandleShape = 'empty' | 'invalid' | 'short' | 'long' | 'ok'

export type HandleCheck = {
  /** Trimmed and lowercased, i.e. what the URL would actually contain. */
  normalized: string
  shape: HandleShape
  message: string
  /** Worth sending to the server. Not the same as available. */
  valid: boolean
}

export function checkHandleShape(raw: string): HandleCheck {
  const normalized = raw.trim().toLowerCase()

  const result = (shape: HandleShape, message: string): HandleCheck => ({
    normalized,
    shape,
    message,
    valid: shape === 'ok',
  })

  if (normalized.length === 0) return result('empty', 'Start typing to check availability')
  if (/[^a-z0-9_]/.test(normalized)) {
    return result('invalid', 'Letters, numbers and underscores only')
  }
  if (normalized.length < HANDLE_MIN) return result('short', 'A little longer, please')
  if (normalized.length > HANDLE_MAX) return result('long', `Keep it to ${HANDLE_MAX} characters`)
  // Nothing reads this message -- ClaimHandlePage computes its own once a
  // shape is 'ok'. Kept as a field only because the type requires one.
  return result('ok', '')
}
