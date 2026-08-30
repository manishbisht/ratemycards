/** Handles already claimed in the mock. Transcribed from the design. */
export const TAKEN_HANDLES = ['arjun', 'admin', 'priya', 'cards', 'rohan']

export const HANDLE_MIN = 3
export const HANDLE_MAX = 20

/** The shape a `#u/<handle>` route must match. */
export const HANDLE_PATTERN = new RegExp(`^[a-z0-9_]{${HANDLE_MIN},${HANDLE_MAX}}$`)

export type HandleState = 'empty' | 'invalid' | 'short' | 'long' | 'taken' | 'available'

export type HandleCheck = {
  /** Trimmed and lowercased, i.e. what the URL would actually contain. */
  normalized: string
  state: HandleState
  message: string
  available: boolean
}

/**
 * Mirrors the design's availability check. The one addition is the `long`
 * case: the design only states the 20-character cap in helper text and never
 * enforces it, which would let someone claim a handle whose `#u/...` route
 * then fails to parse.
 */
export function checkHandle(raw: string): HandleCheck {
  const normalized = raw.trim().toLowerCase()

  const result = (state: HandleState, message: string): HandleCheck => ({
    normalized,
    state,
    message,
    available: state === 'available',
  })

  if (normalized.length === 0) return result('empty', 'Start typing to check availability')
  if (/[^a-z0-9_]/.test(normalized)) {
    return result('invalid', 'Letters, numbers and underscores only')
  }
  if (normalized.length < HANDLE_MIN) return result('short', 'A little longer, please')
  if (normalized.length > HANDLE_MAX) return result('long', `Keep it to ${HANDLE_MAX} characters`)
  if (TAKEN_HANDLES.includes(normalized)) {
    return result('taken', 'Taken. Try arjun_k or arjun2447')
  }
  return result('available', 'Available')
}
