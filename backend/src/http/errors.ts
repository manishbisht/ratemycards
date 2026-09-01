import type { ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from '../env'

export type ErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'internal_error'

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal_error: 500,
}

/** Every failure leaves the API as `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  readonly code: ErrorCode
  readonly details: string[] | undefined

  constructor(code: ErrorCode, message: string, details?: string[]) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = details
  }

  get status(): ContentfulStatusCode {
    return STATUS[this.code]
  }

  static validation(details: string[]): ApiError {
    return new ApiError('validation_error', 'The request body is invalid.', details)
  }

  static notFound(what: string): ApiError {
    return new ApiError('not_found', `${what} was not found.`)
  }

  static conflict(message: string): ApiError {
    return new ApiError('conflict', message)
  }

  static unauthorized(message = 'A valid admin bearer token is required.'): ApiError {
    return new ApiError('unauthorized', message)
  }

  /**
   * Authenticated, but not allowed. Distinct from `unauthorized` because the
   * two want opposite things from a client: a 401 means present a credential,
   * a 403 means the credential you presented will never work. Signing out and
   * back in fixes one and not the other.
   */
  static forbidden(message: string): ApiError {
    return new ApiError('forbidden', message)
  }
}

function body(code: ErrorCode, message: string, details?: string[]) {
  return { error: details ? { code, message, details } : { code, message } }
}

/**
 * Hono's own middleware (bearer-auth, body parsing) throws HTTPException, so
 * those are remapped into the same envelope rather than escaping as bare text.
 */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof ApiError) {
    return c.json(body(err.code, err.message, err.details), err.status)
  }

  if (err instanceof HTTPException) {
    const code: ErrorCode = err.status === 401 ? 'unauthorized' : 'validation_error'
    const response = c.json(
      body(code, err.message || 'Request rejected.'),
      err.status as ContentfulStatusCode,
    )
    // Replacing the middleware's response with the JSON envelope would
    // otherwise drop the auth challenge, which RFC 7235 requires on a 401.
    const challenge = err.getResponse().headers.get('www-authenticate')
    if (challenge) response.headers.set('WWW-Authenticate', challenge)
    return response
  }

  console.error('Unhandled error', err)
  return c.json(body('internal_error', 'Something went wrong.'), 500)
}

/**
 * `c.req.json()` throws on malformed input, which would otherwise surface as a
 * 500 for what is squarely a client mistake.
 */
export async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw ApiError.validation(['The request body must be valid JSON.'])
  }
}

/** Hono answers unmatched routes with text/plain by default; keep the envelope. */
export const notFound: NotFoundHandler<AppEnv> = (c) =>
  c.json(body('not_found', 'No route matches this request.'), 404)
