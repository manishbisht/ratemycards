import { SELF, env } from 'cloudflare:test'
import { signJwt } from '@clerk/backend/jwt'
import { describe, expect, it } from 'vitest'

/**
 * users.is_admin, and the ADMIN_EMAILS allowlist that grants it.
 *
 * A *write* file: storage isolation is per file, so the users minted here are
 * invisible to the seed-count assertions elsewhere.
 *
 * Tokens are real, signed with the keypair vitest.config.ts generates and
 * verified by the Worker against the JWKS the same config serves back. The
 * allowlist under test is the ADMIN_EMAILS binding there --
 * 'Admin@Test.Example, second-admin@test.example ' -- whose stray whitespace
 * and mixed case are deliberate.
 */

const base = 'http://api.test'
const AZP = 'http://localhost:5173'

async function mintToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  return signJwt(
    { iss: 'https://clerk.test.example', azp: AZP, iat: now - 5, nbf: now - 5, exp: now + 600, ...claims },
    JSON.parse(env.TEST_JWT_PRIVATE_KEY) as JsonWebKey,
    { algorithm: 'RS256', header: { kid: env.TEST_JWT_KID } },
  )
}

/** GET /v1/users/me as whoever this token is. */
async function me(token: string) {
  const res = await SELF.fetch(`${base}/v1/users/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: (await res.json()) as any }
}

function isAdminInDb(clerkId: string) {
  return env.DB.prepare('SELECT is_admin FROM users WHERE clerk_id = ?')
    .bind(clerkId)
    .first<{ is_admin: number }>()
}

describe('the ADMIN_EMAILS grant', () => {
  it('makes an allowlisted address an admin on first sign-in', async () => {
    const token = await mintToken({ sub: 'user_grant_first', email: 'admin@test.example' })

    const { status, body } = await me(token)
    expect(status).toBe(200)
    expect(body.isAdmin).toBe(true)
    expect((await isAdminInDb('user_grant_first'))?.is_admin).toBe(1)
  })

  it('leaves an address that is not on the list alone', async () => {
    const token = await mintToken({ sub: 'user_grant_other', email: 'nobody@test.example' })

    expect((await me(token)).body.isAdmin).toBe(false)
    expect((await isAdminInDb('user_grant_other'))?.is_admin).toBe(0)
  })

  it('matches case-insensitively and ignores whitespace around an entry', async () => {
    // The binding holds 'Admin@Test.Example' and ' second-admin@test.example '.
    const upper = await mintToken({ sub: 'user_grant_case', email: 'ADMIN@TEST.EXAMPLE' })
    expect((await me(upper)).body.isAdmin).toBe(true)

    const padded = await mintToken({ sub: 'user_grant_second', email: 'second-admin@test.example' })
    expect((await me(padded)).body.isAdmin).toBe(true)
  })

  /**
   * The crux. A Clerk JWT template need not include an `email` claim, and most
   * requests arrive without one. Reconciling against the *incoming* identity
   * rather than the row's settled email would mean an existing user could never
   * be granted -- and, worse, that every claimless request looked like "not an
   * admin".
   */
  it('grants an existing row whose token carries no email claim', async () => {
    // First contact establishes the row and its email, but not the grant:
    // pretend the address was added to the allowlist afterwards by starting
    // from an address that is on it, with the claim present only this once.
    const withEmail = await mintToken({ sub: 'user_grant_later', email: 'admin@test.example' })
    await me(withEmail)

    await env.DB.prepare("UPDATE users SET is_admin = 0 WHERE clerk_id = 'user_grant_later'").run()

    const withoutEmail = await mintToken({ sub: 'user_grant_later' })
    expect((await me(withoutEmail)).body.isAdmin).toBe(true)
  })

  it('never revokes: a later claimless request keeps the flag', async () => {
    const withEmail = await mintToken({ sub: 'user_grant_keep', email: 'admin@test.example' })
    expect((await me(withEmail)).body.isAdmin).toBe(true)

    const claimless = await mintToken({ sub: 'user_grant_keep' })
    expect((await me(claimless)).body.isAdmin).toBe(true)
    expect((await isAdminInDb('user_grant_keep'))?.is_admin).toBe(1)
  })

  /**
   * Clerk's default session token carries no `email` at all; one appears only
   * if the JWT template was customised, and the shorthand differs by who wrote
   * it. Missing every spelling is what leaves users.email NULL and makes the
   * allowlist unmatchable, so the fallbacks are worth pinning.
   */
  it('accepts the other spellings a JWT template might use', async () => {
    const primary = await mintToken({
      sub: 'user_grant_primary',
      primary_email_address: 'admin@test.example',
    })
    expect((await me(primary)).body.isAdmin).toBe(true)

    const addressed = await mintToken({
      sub: 'user_grant_addressed',
      email_address: 'second-admin@test.example',
    })
    expect((await me(addressed)).body.isAdmin).toBe(true)
  })

  it('leaves the row unmatchable when the token carries no address at all', async () => {
    // The local-dev failure mode, pinned: no claim and no webhook means no
    // email on the row, and an allowlist match against null is false.
    const bare = await mintToken({ sub: 'user_grant_bare' })

    const { body } = await me(bare)
    expect(body.email).toBeNull()
    expect(body.isAdmin).toBe(false)
  })

  /**
   * The grant is a reconcile *after* the upsert, not a value written by the
   * INSERT, so a row that predates the allowlist -- or predates the column --
   * is granted on its next authenticated request like any other.
   *
   * This walks the exact history of a real local account: signed in long before
   * any of this existed, so the row was created with no email at all; the
   * address backfilled by hand later; then an ordinary claimless request.
   */
  it('grants a row that predates the allowlist entirely', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, clerk_id, email, name, image_url, is_admin)
       VALUES ('user_' || lower(hex(randomblob(16))), 'user_grant_legacy', NULL, NULL, NULL, 0)`,
    ).run()

    const legacy = await mintToken({ sub: 'user_grant_legacy' })
    expect((await me(legacy)).body.isAdmin).toBe(false)
    expect((await isAdminInDb('user_grant_legacy'))?.is_admin).toBe(0)

    // The manual backfill, exactly as the README prescribes.
    await env.DB.prepare(
      "UPDATE users SET email = 'admin@test.example' WHERE clerk_id = 'user_grant_legacy'",
    ).run()

    // One ordinary request later, with no email claim on the token.
    expect((await me(legacy)).body.isAdmin).toBe(true)
    expect((await isAdminInDb('user_grant_legacy'))?.is_admin).toBe(1)
  })

  it('does not let a client declare itself an admin', async () => {
    // is_admin is read from the row, never from a claim.
    const token = await mintToken({
      sub: 'user_grant_liar',
      email: 'nobody@test.example',
      isAdmin: true,
      is_admin: 1,
      admin: true,
    })

    expect((await me(token)).body.isAdmin).toBe(false)
  })
})
