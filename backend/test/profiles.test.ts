import { SELF, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

/** A *write* file: it mints its own bank, card and users. */

const base = 'http://api.test'
const ADMIN = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }

let cardId = ''

beforeAll(async () => {
  const bank = (await (
    await SELF.fetch(`${base}/v1/banks`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ name: 'Profile Bank' }),
    })
  ).json()) as any

  cardId = (
    (await (
      await SELF.fetch(`${base}/v1/cards`, {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify({
          bankId: bank.id,
          name: 'Profile Card',
          country: 'IN',
          joiningFee: 0,
          annualFee: 0,
        }),
      })
    ).json()) as any
  ).id

  await env.DB.prepare(
    `INSERT INTO users (id, clerk_id, email, name, image_url, handle)
     VALUES ('user_11111111111111111111111111111111', 'user_profile_owner',
             'owner@test.example', 'Owner Name', 'https://img.test/x.png', 'profileowner')`,
  ).run()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO wallet_cards (user_id, card_id, verification_status, verified_at)
       VALUES ('user_11111111111111111111111111111111', ?, 'verified', '2026-09-01T00:00:00Z')`,
    ).bind(cardId),
  ])

  // A deactivated owner, and one who has claimed nothing.
  await env.DB.prepare(
    `INSERT INTO users (id, clerk_id, is_active, handle)
     VALUES ('user_22222222222222222222222222222222', 'user_profile_gone', 0, 'goneaway')`,
  ).run()
})

function profile(handle: string) {
  return SELF.fetch(`${base}/v1/profiles/${handle}`)
}

describe('GET /v1/profiles/:handle', () => {
  it('is readable with no session at all', async () => {
    const res = await profile('profileowner')
    expect(res.status).toBe(200)

    const body = (await res.json()) as any
    expect(body.handle).toBe('profileowner')
    expect(body.cardCount).toBe(1)
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0].name).toBe('Profile Card')
    expect(body.tier).toHaveProperty('name')
  })

  /** The whole point of the projection. */
  it('leaks nothing that identifies the person', async () => {
    const text = await (await profile('profileowner')).text()

    for (const secret of [
      'owner@test.example',
      'Owner Name',
      'https://img.test/x.png',
      'user_11111111111111111111111111111111',
      'user_profile_owner',
    ]) {
      expect(text, secret).not.toContain(secret)
    }
  })

  /**
   * The substring check above only knows today's PII values. This one is the
   * durable guard: it fails on *any* extra field, whatever value it carries,
   * so a field added to Card or StoredWallet later cannot ride along silently
   * -- the projection would need to be edited, and reviewed, to carry it.
   */
  it('exposes only the documented fields', async () => {
    const body = (await (await profile('profileowner')).json()) as any

    expect(Object.keys(body).sort()).toEqual(
      ['cardCount', 'cards', 'handle', 'maxScore', 'score', 'tier'].sort(),
    )
    expect(Object.keys(body.cards[0]).sort()).toEqual(['bank', 'id', 'issuer', 'name'].sort())
    expect(Object.keys(body.cards[0].bank).sort()).toEqual(['id', 'name'].sort())
  })

  it('normalises the handle in the path', async () => {
    expect((await profile('ProfileOwner')).status).toBe(200)
  })

  it('404s a handle nobody holds', async () => {
    const res = await profile('nobodyhasthis')
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error.code).toBe('not_found')
  })

  it('404s a malformed handle rather than 500ing', async () => {
    expect((await profile('has-dash')).status).toBe(404)
  })

  it('404s once the owner is deactivated', async () => {
    expect((await profile('goneaway')).status).toBe(404)
  })
})
