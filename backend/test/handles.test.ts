import { SELF, env } from 'cloudflare:test'
import { signJwt } from '@clerk/backend/jwt'
import { describe, expect, it } from 'vitest'

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
