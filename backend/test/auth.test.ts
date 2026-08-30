import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const base = 'http://api.test'
const VALID = 'test-admin-token'

function post(token?: string) {
  return SELF.fetch(`${base}/v1/cards`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { Authorization: token }),
    },
    body: JSON.stringify({}),
  })
}

describe('admin auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await post()
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe('unauthorized')
  })

  /**
   * workerd's crypto.subtle.timingSafeEqual throws on unequal byte lengths, so
   * a hand-rolled comparison would turn a short token into a 500 -- and leak a
   * length oracle. hono/bearer-auth hashes both sides first; this pins that.
   */
  it('rejects a wrong-length token with 401, not 500', async () => {
    expect((await post('Bearer x')).status).toBe(401)
    expect((await post(`Bearer ${'a'.repeat(500)}`)).status).toBe(401)
  })

  it('rejects a same-length but incorrect token', async () => {
    expect((await post('Bearer test-admin-tokeN')).status).toBe(401)
  })

  // RFC 6750 splits these: a malformed Authorization header is
  // error="invalid_request" (400), a bad token is invalid_token (401).
  it('rejects a token sent without the Bearer scheme', async () => {
    const res = await post(VALID)
    expect(res.status).toBe(400)
    expect(res.headers.get('www-authenticate')).toContain('invalid_request')
  })

  it('accepts the valid token and proceeds to validation', async () => {
    // Empty body, so it must get past auth and fail validation instead.
    const res = await post(`Bearer ${VALID}`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe('validation_error')
  })

  it('leaves reads public', async () => {
    expect((await SELF.fetch(`${base}/v1/cards`)).status).toBe(200)
  })
})
