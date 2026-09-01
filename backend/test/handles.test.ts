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
