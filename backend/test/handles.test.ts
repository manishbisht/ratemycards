import { SELF, env } from 'cloudflare:test'
import { signJwt } from '@clerk/backend/jwt'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/http/errors'
import { getUserByHandle, setHandle } from '../src/modules/users/queries'

/**
 * Handles: the column, the claim, and availability.
 *
 * A *write* file -- storage isolation is per file, so the users minted here are
 * invisible to the seed-count assertions elsewhere.
 */

const base = 'http://api.test'
const AZP = 'http://localhost:5173'

export async function mintToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  return signJwt(
    { iss: 'https://clerk.test.example', azp: AZP, iat: now - 5, nbf: now - 5, exp: now + 600, ...claims },
    JSON.parse(env.TEST_JWT_PRIVATE_KEY) as JsonWebKey,
    { algorithm: 'RS256', header: { kid: env.TEST_JWT_KID } },
  )
}

async function me(token: string) {
  const res = await SELF.fetch(`${base}/v1/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: (await res.json()) as any }
}

/**
 * A user row with no session behind it -- setHandle/getUserByHandle operate on
 * `users.id`, not the Clerk id a token carries, so the tests below need a row
 * they can address by that id directly rather than going through /v1/users/me.
 *
 * The literal id must satisfy 0007's CHECK (`user_` + 32 lowercase hex), the
 * same rule 'user_' || lower(hex(randomblob(16))) already satisfies elsewhere
 * in this codebase (see adminIdentity.test.ts).
 */
async function createUser(clerkId: string): Promise<string> {
  const row = await env.DB.prepare(
    "INSERT INTO users (id, clerk_id) VALUES ('user_' || lower(hex(randomblob(16))), ?) RETURNING id",
  )
    .bind(clerkId)
    .first<{ id: string }>()
  if (!row) throw new Error(`failed to insert a user row for '${clerkId}'`)
  return row.id
}

describe('users.handle', () => {
  it('is null until claimed and is serialised on /v1/users/me', async () => {
    const token = await mintToken({ sub: 'user_handle_fresh' })

    const { status, body } = await me(token)
    expect(status).toBe(200)
    expect(body).toHaveProperty('handle')
    expect(body.handle).toBeNull()
  })

  it('lets many users have no handle at once', async () => {
    // A UNIQUE index over a nullable column must permit repeated NULLs, or the
    // second person to sign in cannot be created at all.
    for (const sub of ['user_handle_nullA', 'user_handle_nullB', 'user_handle_nullC']) {
      expect((await me(await mintToken({ sub }))).status).toBe(200)
    }

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE handle IS NULL AND clerk_id LIKE 'user_handle_null%'",
    ).first<{ n: number }>()
    expect(row?.n).toBe(3)
  })

  it('refuses two rows with the same handle', async () => {
    await me(await mintToken({ sub: 'user_handle_dupA' }))
    await me(await mintToken({ sub: 'user_handle_dupB' }))

    await env.DB.prepare("UPDATE users SET handle = 'duplicand' WHERE clerk_id = 'user_handle_dupA'").run()

    await expect(
      env.DB.prepare("UPDATE users SET handle = 'duplicand' WHERE clerk_id = 'user_handle_dupB'").run(),
    ).rejects.toThrow(/UNIQUE/i)
  })

  it('refuses a handle the CHECK constraint rejects', async () => {
    await me(await mintToken({ sub: 'user_handle_bad' }))

    for (const bad of ['Uppercase', 'has-dash', 'ab', 'x'.repeat(21), 'has space']) {
      await expect(
        env.DB.prepare('UPDATE users SET handle = ? WHERE clerk_id = ?')
          .bind(bad, 'user_handle_bad')
          .run(),
        bad,
      ).rejects.toThrow(/CHECK/i)
    }
  })
})

describe('setHandle and getUserByHandle', () => {
  it('sets a handle and returns the updated user with it populated', async () => {
    const id = await createUser('clerk_handle_direct_set')

    const user = await setHandle(env.DB, id, 'directclaim')
    expect(user.id).toBe(id)
    expect(user.handle).toBe('directclaim')
  })

  it('round-trips through getUserByHandle, and returns null for a handle nobody holds', async () => {
    const id = await createUser('clerk_handle_direct_roundtrip')
    await setHandle(env.DB, id, 'roundtrip')

    const found = await getUserByHandle(env.DB, 'roundtrip')
    expect(found?.id).toBe(id)

    expect(await getUserByHandle(env.DB, 'nobodyholdsthis')).toBeNull()
  })

  /**
   * The load-bearing case: setHandle must translate D1's raw
   * 'UNIQUE constraint failed' into ApiError.conflict, not let it escape as an
   * unhandled 500. Asserting on `.code` rather than just `rejects.toThrow`
   * pins that translation, not merely that *something* throws.
   */
  it('rejects the second claim of a handle with an ApiError coded conflict', async () => {
    const first = await createUser('clerk_handle_direct_racerA')
    const second = await createUser('clerk_handle_direct_racerB')

    await setHandle(env.DB, first, 'contested')

    let thrown: unknown
    try {
      await setHandle(env.DB, second, 'contested')
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(ApiError)
    expect((thrown as ApiError).code).toBe('conflict')
  })

  it('lets the same user re-send the handle they already hold', async () => {
    const id = await createUser('clerk_handle_direct_resend')
    await setHandle(env.DB, id, 'stable')

    const again = await setHandle(env.DB, id, 'stable')
    expect(again.handle).toBe('stable')
  })
})

function claim(token: string, handle: unknown) {
  return SELF.fetch(`${base}/v1/users/me/handle`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle }),
  })
}

function availability(handle: string) {
  return SELF.fetch(`${base}/v1/handles/${handle}`)
}

/** Gives a user a verified card, which claiming requires. */
async function withVerifiedCard(sub: string): Promise<string> {
  const token = await mintToken({ sub })
  await me(token)

  const admin = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }
  const bank = (await (
    await SELF.fetch(`${base}/v1/banks`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ name: `Handle Bank ${sub}` }),
    })
  ).json()) as any
  const card = (await (
    await SELF.fetch(`${base}/v1/cards`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        bankId: bank.id,
        name: `Handle Card ${sub}`,
        country: 'IN',
        joiningFee: 0,
        annualFee: 0,
      }),
    })
  ).json()) as any

  await SELF.fetch(`${base}/v1/wallet/cards/${card.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  })
  // The status is normally earned through Razorpay; set directly so this file
  // tests handles rather than re-testing verification.
  await env.DB.prepare(
    `UPDATE wallet_cards SET verification_status = 'verified', verified_at = '2026-09-01T00:00:00Z'
     WHERE card_id = ?`,
  )
    .bind(card.id)
    .run()

  return token
}

describe('PUT /v1/users/me/handle', () => {
  it('claims a handle and returns the updated user', async () => {
    const token = await withVerifiedCard('user_claim_ok')

    const res = await claim(token, 'claimed_one')
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).handle).toBe('claimed_one')
    expect((await me(token)).body.handle).toBe('claimed_one')
  })

  it('409s a handle somebody else already holds', async () => {
    const first = await withVerifiedCard('user_claim_first')
    const second = await withVerifiedCard('user_claim_second')

    // Not 'contested': the queries-level test above already owns that name via
    // a direct setHandle call, and storage isolation is per file, not per
    // test -- reusing it here would 409 on the *first* claim, not the second.
    expect((await claim(first, 'disputed')).status).toBe(200)

    const res = await claim(second, 'disputed')
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('conflict')
  })

  // The 409 above only says the response was right. This is the case that
  // actually matters: the loser's own row must be untouched, not silently
  // pointed at the name it lost the race for -- a bug where setHandle ran
  // anyway and only the response lied would pass the test above.
  it('does not leave the loser of a conflict owning the handle', async () => {
    const first = await withVerifiedCard('user_claim_loser_first')
    const second = await withVerifiedCard('user_claim_loser_second')

    expect((await claim(first, 'onlyoneowner')).status).toBe(200)
    expect((await claim(second, 'onlyoneowner')).status).toBe(409)

    expect((await me(second)).body.handle).toBeNull()
    expect((await me(first)).body.handle).toBe('onlyoneowner')
  })

  it('lets the same person re-send the handle they already hold', async () => {
    const token = await withVerifiedCard('user_claim_again')
    expect((await claim(token, 'idempotent1')).status).toBe(200)
    expect((await claim(token, 'idempotent1')).status).toBe(200)
  })

  it('frees the previous handle when one is changed', async () => {
    const owner = await withVerifiedCard('user_claim_mover')
    const other = await withVerifiedCard('user_claim_taker')

    expect((await claim(owner, 'movable')).status).toBe(200)
    expect((await claim(owner, 'movedaway')).status).toBe(200)

    // Freed, per the design's deliberate trade.
    expect((await claim(other, 'movable')).status).toBe(200)
  })

  it('refuses a claim with no verified card', async () => {
    const token = await mintToken({ sub: 'user_claim_unverified' })
    await me(token)

    const res = await claim(token, 'toosoon')
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.message).toMatch(/verif/i)
  })

  // The 409 above only says the response was right. This is the case that
  // actually matters: the gate must run before setHandle is ever called, not
  // merely report failure after the write already went through.
  it('leaves the handle unset when the verified-card gate refuses the claim', async () => {
    const token = await mintToken({ sub: 'user_claim_unverified_check' })
    await me(token)

    expect((await claim(token, 'shouldnotstick')).status).toBe(409)
    expect((await me(token)).body.handle).toBeNull()
  })

  it('401s an anonymous caller', async () => {
    const res = await SELF.fetch(`${base}/v1/users/me/handle`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'anonymous1' }),
    })
    expect(res.status).toBe(401)
  })

  it('400s a malformed handle, with details', async () => {
    const token = await withVerifiedCard('user_claim_bad')

    const res = await claim(token, 'no')
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.details.join(' ')).toMatch(/3 to 20/)
  })

  // Reserved is a 400 from the validator, not a 409: it is a bad value caught
  // before any database work, not a race. The spec's error table says 409 and
  // is corrected in Task 8.
  it('400s a reserved handle', async () => {
    const token = await withVerifiedCard('user_claim_reserved')
    const res = await claim(token, 'admin')
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.details.join(' ')).toMatch(/reserved/i)
  })
})

describe('GET /v1/handles/:handle', () => {
  it('reports an unclaimed handle as available, with no session', async () => {
    const res = await availability('never_taken')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ handle: 'never_taken', available: true })
  })

  it('reports a claimed handle as unavailable', async () => {
    const token = await withVerifiedCard('user_avail_owner')
    await claim(token, 'occupied')

    expect(await (await availability('occupied')).json()).toEqual({
      handle: 'occupied',
      available: false,
    })
  })

  /**
   * Availability answers one question -- would claiming this succeed -- so
   * reserved and malformed are false rather than a 409 and a 400. Anything else
   * puts a tick over a handle the claim will reject.
   */
  it('reports reserved and malformed handles as unavailable, not as errors', async () => {
    for (const handle of ['admin', 'no', 'x'.repeat(21), 'has-dash']) {
      const res = await availability(handle)
      expect(res.status, handle).toBe(200)
      expect(((await res.json()) as any).available, handle).toBe(false)
    }
  })

  it('normalises case', async () => {
    const token = await withVerifiedCard('user_avail_case')
    await claim(token, 'casetest')

    const res = await availability('CaseTest')
    expect(await res.json()).toEqual({ handle: 'casetest', available: false })
  })
})
