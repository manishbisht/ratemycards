# Public Handles and Real Profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a handle a row nobody else can take, and `#/u/<handle>` an endpoint anyone can open with no session.

**Architecture:** A `UNIQUE` column on `users` — the index *is* the uniqueness guarantee, not a read-then-write. Claiming and availability live in the users module, which owns that column. The public read gets its own `profiles` module that writes no SQL: it calls `users.getUserByHandle` and `wallet.getVerifiedWallet` and projects the result, so the users module keeps its stated invariant that it never returns anyone else's row.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), TypeScript, vitest via `@cloudflare/vitest-plugin`. Frontend: Vite, React 19, Redux Toolkit, CSS Modules.

**Spec:** `docs/superpowers/specs/2026-09-01-public-handles-design.md`

## Global Constraints

- Handles are `^[a-z0-9_]{3,20}$`, lowercased and trimmed before anything else sees them.
- Reserved: `admin`, `api`, `www`, `u`, `health`. Refused with 409.
- Validators produce the good 400; the migration `CHECK` is the backstop no write path can bypass. Change one, change the other (`src/http/validators.ts:10-13`).
- Validation is accumulator-style: collect every problem, report them together.
- No module writes SQL against another module's tables (`backend/README.md:26`). Cross-module work goes through an exported function.
- Every mutation route carries a guard. The count of `requireUser` in a routes file must equal its number of authenticated handlers.
- Test files have per-file storage isolation; any file that writes creates its own users, banks and cards.
- Run `npm test` from `backend/`. The full suite must be green at the end of every task.
- Frontend has no test harness. Its gate is `npx tsc -b`, `npm run lint`, `npm run build`.
- Node 22 (`nvm use` at the repo root) — wrangler refuses anything older.

---

### Task 1: The handle column and the queries over it

Adds the column, the unique index, and the two query functions everything later
depends on. `GET /v1/users/me` starts returning `handle` as a consequence of the
`User` type gaining it.

**Files:**
- Create: `backend/migrations/0014_add_user_handle.sql`
- Modify: `backend/src/modules/users/userTypes.ts`
- Modify: `backend/src/modules/users/queries.ts`
- Create: `backend/test/handles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `User.handle: string | null`; `HANDLE_MIN = 3`, `HANDLE_MAX = 20`, `HANDLE_PATTERN: RegExp`, `RESERVED_HANDLES: readonly string[]`, `isReservedHandle(value: string): boolean` from `userTypes.ts`; `getUserByHandle(db: D1Database, handle: string): Promise<User | null>` and `setHandle(db: D1Database, userId: string, handle: string): Promise<User>` from `queries.ts`. `setHandle` throws `ApiError.conflict` when the handle is taken.

- [ ] **Step 1: Write the failing test**

Create `backend/test/handles.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/handles.test.ts`
Expected: FAIL — `no such column: handle`.

- [ ] **Step 3: Write the migration**

Create `backend/migrations/0014_add_user_handle.sql`. The first line's separator
is a literal tab, matching every other migration:

```sql
-- Migration number: 0014 	 2026-09-01T00:00:00.000Z
-- The public name a wallet is shared under: ratemycards.../#/u/<handle>.
--
-- A column rather than a table. The relationship is one to one, nothing hangs
-- off a handle, and no history is kept -- renaming returns the old value to the
-- pool, which is a deliberate trade recorded in the design doc.
--
-- THE INDEX IS THE UNIQUENESS GUARANTEE, not the validator and not a
-- SELECT-then-UPDATE. Two people claiming the same handle in the same instant
-- both pass any read-first check and one silently overwrites the other; against
-- a unique index one UPDATE wins and the other raises, which queries.ts turns
-- into a 409.
--
-- SQLite permits any number of NULLs in a unique index, so everyone who has not
-- claimed costs nothing and collides with nothing.
--
-- The CHECK mirrors HANDLE_PATTERN in users/userTypes.ts. Change one, change
-- the other. `_` is literal inside a GLOB character class -- it is LIKE, not
-- GLOB, that treats it as a wildcard.

ALTER TABLE users ADD COLUMN handle TEXT
  CHECK (handle IS NULL OR (NOT handle GLOB '*[^a-z0-9_]*' AND length(handle) BETWEEN 3 AND 20));

CREATE UNIQUE INDEX idx_users_handle ON users(handle);
```

- [ ] **Step 4: Add the handle types**

Append to `backend/src/modules/users/userTypes.ts`:

```ts
/**
 * Mirrors the CHECK in migration 0014 and HANDLE_PATTERN in the frontend's
 * data/handles.ts. Change one, change all three.
 */
export const HANDLE_MIN = 3
export const HANDLE_MAX = 20
export const HANDLE_PATTERN = new RegExp(`^[a-z0-9_]{${HANDLE_MIN},${HANDLE_MAX}}$`)

/**
 * Not a routing concern -- profiles live under `#/u/`, so `admin` as a handle
 * would resolve perfectly well. The point is that `@admin` on a page about
 * somebody's money reads as authority nobody granted.
 */
export const RESERVED_HANDLES: readonly string[] = ['admin', 'api', 'www', 'u', 'health']

export function isReservedHandle(value: string): boolean {
  return RESERVED_HANDLES.includes(value)
}
```

And add `handle` to the `User` type, immediately after `imageUrl`:

```ts
  /** The public profile name, or null until one is claimed. */
  handle: string | null
```

- [ ] **Step 5: Carry the column through the queries**

In `backend/src/modules/users/queries.ts`:

Add `handle: string | null` to `UserRow`, add `handle` to `USER_COLUMNS`, and map
it in `toUser`:

```ts
const USER_COLUMNS = 'id, email, name, image_url, is_active, is_admin, handle'
```

```ts
    isAdmin: row.is_admin === 1,
    handle: row.handle,
```

Leave the `ON CONFLICT DO UPDATE` in `upsertUserByClerkId` alone. It must not
touch `handle` for the same reason it must not touch `is_admin`: Clerk has no
opinion about either, and a webhook arriving must never clear one.

Then append the two new functions:

```ts
export async function getUserByHandle(db: D1Database, handle: string): Promise<User | null> {
  const row = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE handle = ?`)
    .bind(handle)
    .first<UserRow>()
  return row ? toUser(row) : null
}

/**
 * Claims or changes a handle.
 *
 * The conflict is detected by letting the unique index reject the write rather
 * than by looking first: a read-then-write races, and the window is exactly the
 * moment two people are racing for the same name.
 *
 * Renaming frees the previous value as a side effect of this being one column.
 */
export async function setHandle(db: D1Database, userId: string, handle: string): Promise<User> {
  try {
    await db
      .prepare(`UPDATE users SET handle = ?, updated_at = ${NOW} WHERE id = ?`)
      .bind(handle, userId)
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict(`'${handle}' is already taken.`)
    }
    throw err
  }

  const user = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserRow>()
  if (!user) throw ApiError.notFound('Your account')
  return toUser(user)
}

/**
 * The fourth copy in this codebase -- banks/queries.ts:126,
 * networks/queries.ts:231, scoring/queries.ts:220 all carry the same private
 * helper. Following the house pattern rather than refactoring four modules
 * while adding a feature.
 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}
```

Add the import at the top of the file:

```ts
import { ApiError } from '../../http/errors'
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && npx vitest run test/handles.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Pin that a webhook cannot clear a handle**

`upsertUserByClerkId` runs on every authenticated request and on every Clerk
webhook. It must leave `handle` alone for the same reason it leaves `is_admin`
alone. Append to `backend/test/usersWebhook.test.ts`, inside the existing
top-level `describe`:

```ts
  it('leaves an existing handle alone', async () => {
    await send('user.created', userPayload({ id: 'user_webhook_handle' }))
    await env.DB.prepare(
      "UPDATE users SET handle = 'webhookheld' WHERE clerk_id = 'user_webhook_handle'",
    ).run()

    // A later update -- a changed name, a new avatar -- must not touch it.
    await send('user.updated', userPayload({ id: 'user_webhook_handle', first_name: 'Renamed' }))

    const row = await env.DB.prepare(
      "SELECT handle FROM users WHERE clerk_id = 'user_webhook_handle'",
    ).first<{ handle: string | null }>()
    expect(row?.handle).toBe('webhookheld')
  })
```

If `send` and `userPayload` are named differently in that file, use whatever its
existing tests use — read the top of the file first; the point is one
`user.created`, a direct `UPDATE`, then one `user.updated`.

Run: `cd backend && npx vitest run test/usersWebhook.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `cd backend && npm run typecheck && npm test`
Expected: PASS. `/v1/users/me` gains a field, which breaks nothing that reads it.

- [ ] **Step 9: Rebuild the local database and commit**

```bash
cd backend && npm run migrate:local
```

```bash
git add backend/migrations/0014_add_user_handle.sql backend/src/modules/users \
        backend/test/handles.test.ts backend/test/usersWebhook.test.ts
git commit -m "feat(users): add the handle column and its unique index

A UNIQUE column on users rather than a table of its own: one handle per
person, nothing hangs off it, no history kept. SQLite allows repeated NULLs
in a unique index, so everyone who has not claimed collides with nothing.

setHandle detects a conflict by letting the index reject the write instead of
reading first, because a read-then-write races precisely when two people are
going for the same name."
```

---

### Task 2: Validating a handle

A pure validator, so it unit-tests without a Worker. Split from the route
because the route is HTTP and this is a string.

**Files:**
- Modify: `backend/src/modules/users/validate.ts`
- Create: `backend/test/handleValidate.test.ts`

**Interfaces:**
- Consumes: `HANDLE_MAX`, `HANDLE_MIN`, `HANDLE_PATTERN`, `isReservedHandle` from Task 1.
- Produces: `type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }` and `validateHandleInput(body: unknown): Validated<string>` from `users/validate.ts`. The returned value is normalised — trimmed and lowercased.

- [ ] **Step 1: Write the failing test**

Create `backend/test/handleValidate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateHandleInput } from '../src/modules/users/validate'

/** Pure -- no Worker, no database. */

function errorsFor(body: unknown): string[] {
  const result = validateHandleInput(body)
  return result.ok ? [] : result.errors
}

function valueFor(body: unknown): string | undefined {
  const result = validateHandleInput(body)
  return result.ok ? result.value : undefined
}

describe('validateHandleInput', () => {
  it('accepts a well-formed handle', () => {
    expect(valueFor({ handle: 'arjun_k' })).toBe('arjun_k')
    expect(valueFor({ handle: 'a1b2c3' })).toBe('a1b2c3')
  })

  it('normalises case and surrounding whitespace', () => {
    expect(valueFor({ handle: '  ArjunK  ' })).toBe('arjunk')
  })

  it('rejects a body that is not an object', () => {
    expect(errorsFor('arjun').join(' ')).toMatch(/JSON object/)
  })

  it('rejects a missing or non-string handle', () => {
    expect(errorsFor({}).length).toBeGreaterThan(0)
    expect(errorsFor({ handle: 42 }).length).toBeGreaterThan(0)
  })

  it('rejects handles outside the length bounds', () => {
    expect(errorsFor({ handle: 'ab' }).join(' ')).toMatch(/3 to 20/)
    expect(errorsFor({ handle: 'x'.repeat(21) }).join(' ')).toMatch(/3 to 20/)
  })

  it('rejects characters outside the alphabet', () => {
    for (const bad of ['has-dash', 'has space', 'dot.dot', 'emoji🙂x']) {
      expect(errorsFor({ handle: bad }).length, bad).toBeGreaterThan(0)
    }
  })

  it('rejects a reserved handle', () => {
    for (const reserved of ['admin', 'api', 'www', 'health']) {
      expect(errorsFor({ handle: reserved }).join(' '), reserved).toMatch(/reserved/i)
    }
  })

  it('rejects a reserved handle regardless of case', () => {
    expect(errorsFor({ handle: 'ADMIN' }).join(' ')).toMatch(/reserved/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/handleValidate.test.ts`
Expected: FAIL — `validateHandleInput` is not exported.

- [ ] **Step 3: Write the validator**

Append to `backend/src/modules/users/validate.ts`:

```ts
import { isPlainObject } from '../../http/validators'
import { HANDLE_MAX, HANDLE_MIN, HANDLE_PATTERN, isReservedHandle } from './userTypes'

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run test/handleValidate.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/users/validate.ts backend/test/handleValidate.test.ts
git commit -m "feat(users): validate a claimed handle

Normalises before validating, so a handle typed with stray capitals or
whitespace is accepted rather than rejected for characters its author cannot
see -- and so the reserved-word check cannot be walked past with 'ADMIN'."
```

---

### Task 3: Claiming, and checking availability

Both routes. They share the validator, the reserved list and the definition of
"would this claim succeed", so they are one deliverable.

`/v1/handles` is mounted from the users module, which already exports a second
router this way — `clerkWebhookRoutes` lives in `users/webhook.ts` and mounts at
`/v1/webhooks`.

**Files:**
- Modify: `backend/src/modules/wallet/queries.ts`
- Modify: `backend/src/modules/users/routes.ts`
- Modify: `backend/src/index.ts:37-44`
- Modify: `backend/test/handles.test.ts`

**Interfaces:**
- Consumes: `setHandle`, `getUserByHandle`, `isReservedHandle`, `HANDLE_PATTERN` from Task 1; `validateHandleInput` from Task 2.
- Produces: `countVerifiedCards(db: D1Database, userId: string): Promise<number>` from `wallet/queries.ts`; `handleRoutes` (a `Hono<AppEnv>`) from `users/routes.ts`, mounted at `/v1/handles`; `PUT /v1/users/me/handle`.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/handles.test.ts`:

```ts
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

    expect((await claim(first, 'contested')).status).toBe(200)

    const res = await claim(second, 'contested')
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('conflict')
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

  it('409s a reserved handle', async () => {
    const token = await withVerifiedCard('user_claim_reserved')
    const res = await claim(token, 'admin')
    // Reserved is a 400 from the validator, not a 409 -- it is a bad value, not
    // a race. The frontend shows either the same way.
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/handles.test.ts`
Expected: FAIL — `PUT /v1/users/me/handle` and `/v1/handles/:handle` both 404.

- [ ] **Step 3: Let the wallet module answer "has this person verified anything"**

Append to `backend/src/modules/wallet/queries.ts`:

```ts
/**
 * How many of a person's cards are verified.
 *
 * Exported for the users module, which gates claiming a handle on there being
 * at least one -- it cannot read wallet_cards itself, and counting in SQL beats
 * resolving and scoring a whole wallet to ask a yes/no question.
 */
export async function countVerifiedCards(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM wallet_cards
       WHERE user_id = ? AND verification_status = 'verified'`,
    )
    .bind(userId)
    .first<{ n: number }>()

  return row?.n ?? 0
}
```

- [ ] **Step 4: Write the two routes**

Replace `backend/src/modules/users/routes.ts` entirely:

```ts
import { Hono } from 'hono'
import type { AppEnv } from '../../env'
import { requireUser } from '../../http/clerkAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import { countVerifiedCards } from '../wallet/queries'
import { getUserByClerkId, getUserByHandle, setHandle } from './queries'
import { HANDLE_PATTERN, isReservedHandle } from './userTypes'
import { validateHandleInput } from './validate'

export const userRoutes = new Hono<AppEnv>()

/**
 * The caller's own row. There is deliberately no endpoint that returns anyone
 * else's: a public profile is a *projection*, and it lives in modules/profiles
 * precisely so this stays true.
 */
userRoutes.get('/me', requireUser, async (c) => {
  const auth = c.get('user')
  if (!auth) throw ApiError.unauthorized('A valid session token is required.')

  const user = await getUserByClerkId(c.env.DB, auth.clerkId)
  // requireUser upserts before this runs, so a miss means the row was deleted
  // between the two -- rare, but a 404 says so honestly.
  if (!user) throw ApiError.notFound('Your account')

  return c.json(user)
})

/**
 * Claims a handle, or changes one. Re-sending the handle you already hold is a
 * no-op that succeeds; changing frees the old value, because it is one column.
 *
 * The conflict comes from the unique index inside setHandle rather than from a
 * check here, which is what makes two simultaneous claims safe.
 */
userRoutes.put('/me/handle', requireUser, async (c) => {
  const auth = c.get('user')
  if (!auth) throw ApiError.unauthorized('A valid session token is required.')

  const result = validateHandleInput(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  // The claim screen already refuses to render without a verified card, and
  // says why: a public profile should never exist with nothing behind it. A
  // rule that lives only in the client is not a rule.
  if ((await countVerifiedCards(c.env.DB, auth.id)) === 0) {
    throw ApiError.conflict('Verify at least one card before claiming a handle.')
  }

  return c.json(await setHandle(c.env.DB, auth.id, result.value))
})

/**
 * Whether claiming would succeed. Public, and deliberately not an error for a
 * bad handle: this feeds a tick or a cross beside an input as someone types,
 * and a 400 there would mean showing an error for a half-typed name.
 *
 * It reveals which handles exist, which GET /v1/profiles/:handle already does.
 */
export const handleRoutes = new Hono<AppEnv>()

handleRoutes.get('/:handle', async (c) => {
  const raw = c.req.param('handle').trim().toLowerCase()

  const usable = HANDLE_PATTERN.test(raw) && !isReservedHandle(raw)
  const available = usable && (await getUserByHandle(c.env.DB, raw)) === null

  return c.json({ handle: raw, available })
})
```

- [ ] **Step 5: Mount the second router**

In `backend/src/index.ts`, add the import beside the existing users one:

```ts
import { handleRoutes, userRoutes } from './modules/users/routes'
```

and the mount, immediately after the `/v1/users` line:

```ts
app.route('/v1/handles', handleRoutes)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && npx vitest run test/handles.test.ts`
Expected: PASS, 16 tests.

Note the reserved-handle claim asserts **400**, not 409: the validator catches
it before any database work, and it is a bad value rather than a race. The spec
listed it under 409; the test and this plan are the corrected version, and the
spec's error table should be amended to match in Task 8.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `cd backend && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/users/routes.ts backend/src/modules/wallet/queries.ts \
        backend/src/index.ts backend/test/handles.test.ts
git commit -m "feat(users): claim a handle, and check one for availability

Claiming gates on a verified card server-side. The claim screen already
refused to render without one and said why -- a public profile should never
exist with nothing behind it -- but a rule enforced only in the client is not
enforced.

Availability is deliberately not an error for a reserved or malformed handle.
It feeds a tick beside an input as someone types; a 400 there would mean
showing an error for a half-typed name, and a 200 saying 'available' for a
name the claim would reject is worse."
```

---

### Task 4: The verified-only wallet

The profile scores verified cards only, which is already what the frontend does.
A filtered twin of `getWallet`, in the module that owns `wallet_cards`.

**Files:**
- Modify: `backend/src/modules/wallet/queries.ts`
- Create: `backend/test/verifiedWallet.test.ts`

**Interfaces:**
- Consumes: `listWalletRows`, `listCards`, `scoreWallet`, `toPublicCard` — all already imported in that file.
- Produces: `getVerifiedWallet(db: D1Database, userId: string): Promise<StoredWallet>`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/verifiedWallet.test.ts`:

```ts
import { SELF, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { getVerifiedWallet } from '../src/modules/wallet/queries'

/**
 * A *write* file: it mints its own bank, cards and user.
 *
 * Calls the query directly rather than through a route -- the route that will
 * use it does not exist until Task 5, and this is where the filtering lives.
 */

const base = 'http://api.test'
const ADMIN = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }

let userId = ''
let verifiedId = ''
let unverifiedId = ''

async function create(path: string, body: unknown) {
  const res = await SELF.fetch(`${base}${path}`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify(body),
  })
  expect(res.status, `${path} -> ${await res.clone().text()}`).toBe(201)
  return (await res.json()) as any
}

beforeAll(async () => {
  const bank = await create('/v1/banks', { name: 'Verified Wallet Bank' })
  const card = (name: string) =>
    create('/v1/cards', { bankId: bank.id, name, country: 'IN', joiningFee: 0, annualFee: 0 })

  verifiedId = (await card('Verified One')).id
  unverifiedId = (await card('Unverified One')).id

  await env.DB.prepare(
    `INSERT INTO users (id, clerk_id, handle)
     VALUES ('user_ffffffffffffffffffffffffffffffff', 'user_verified_wallet', 'walletowner')`,
  ).run()
  userId = 'user_ffffffffffffffffffffffffffffffff'

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO wallet_cards (user_id, card_id, verification_status, verified_at)
       VALUES (?, ?, 'verified', '2026-09-01T00:00:00Z')`,
    ).bind(userId, verifiedId),
    env.DB.prepare(
      `INSERT INTO wallet_cards (user_id, card_id, verification_status)
       VALUES (?, ?, 'unverified')`,
    ).bind(userId, unverifiedId),
  ])
})

describe('getVerifiedWallet', () => {
  it('returns only the verified cards', async () => {
    const wallet = await getVerifiedWallet(env.DB, userId)

    expect(wallet.cards.map((entry) => entry.card.id)).toEqual([verifiedId])
    expect(wallet.cards.every((entry) => entry.verificationStatus === 'verified')).toBe(true)
  })

  it('scores the verified set, not the whole wallet', async () => {
    const wallet = await getVerifiedWallet(env.DB, userId)
    expect(wallet.score.cardCount).toBe(1)
  })

  it('returns an empty wallet, scored, for someone with nothing verified', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, clerk_id) VALUES ('user_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'user_nothing')`,
    ).run()

    const wallet = await getVerifiedWallet(env.DB, 'user_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    expect(wallet.cards).toEqual([])
    expect(wallet.score.cardCount).toBe(0)
    expect(wallet.score.score).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/verifiedWallet.test.ts`
Expected: FAIL — `getVerifiedWallet` is not exported.

- [ ] **Step 3: Write the query**

Append to `backend/src/modules/wallet/queries.ts`:

```ts
/**
 * The verified half of a wallet, resolved and scored on its own.
 *
 * A public profile shows only what somebody has proved they hold, and it scores
 * only that -- which is what the frontend already does, so this moves the rule
 * server-side rather than inventing it.
 *
 * Retired and BIN-less cards resolve here for the same reason they do in
 * getWallet: holding a card the catalog dropped should not quietly cost the
 * points it was worth.
 */
export async function getVerifiedWallet(db: D1Database, userId: string): Promise<StoredWallet> {
  const rows = (await listWalletRows(db, userId)).filter(
    (row) => row.verification_status === 'verified',
  )
  const ids = rows.map((row) => row.card_id)

  if (ids.length === 0) {
    return { cards: [], score: scoreWallet([], []) }
  }

  const { cards } = await listCards(db, {
    ids,
    includeInactive: true,
    includeUnselectable: true,
    limit: ids.length,
    offset: 0,
  })

  const byId = new Map(cards.map((card) => [card.id, card]))
  const walletCards: WalletCard[] = []

  // Driven by the rows, so the order they were added survives.
  for (const row of rows) {
    const card = byId.get(row.card_id)
    if (!card) continue

    walletCards.push({
      card: toPublicCard(card),
      verificationStatus: row.verification_status,
      verifiedAt: row.verified_at,
    })
  }

  return { cards: walletCards, score: scoreWallet(cards, ids) }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run test/verifiedWallet.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full suite and commit**

Run: `cd backend && npm run typecheck && npm test`

```bash
git add backend/src/modules/wallet/queries.ts backend/test/verifiedWallet.test.ts
git commit -m "feat(wallet): resolve and score only the verified cards

A public profile shows what somebody has proved they hold and scores only
that, which is what the frontend already did with useWalletScore. This moves
the rule to the server rather than leaving two definitions of it."
```

---

### Task 5: The public profile

The new module. It writes no SQL: it composes two other modules' exported
functions and projects the result, and that projection is the security boundary.

**Files:**
- Create: `backend/src/modules/profiles/profileTypes.ts`
- Create: `backend/src/modules/profiles/routes.ts`
- Modify: `backend/src/index.ts`
- Create: `backend/test/profiles.test.ts`

**Interfaces:**
- Consumes: `getUserByHandle` (Task 1), `getVerifiedWallet` (Task 4).
- Produces: `type PublicProfile`, `toPublicProfile(handle, wallet)`, and `profileRoutes` mounted at `/v1/profiles`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/profiles.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/profiles.test.ts`
Expected: FAIL — every request 404s with "No route matches this request."

- [ ] **Step 3: Write the projection**

Create `backend/src/modules/profiles/profileTypes.ts`:

```ts
import type { StoredWallet, Tier } from '../wallet/walletTypes'

/**
 * What the world may see of somebody's wallet.
 *
 * This type and the function below it are the security boundary for the only
 * unauthenticated read of a person's data in the API, so both are deliberately
 * one short thing to review. Nothing about the *person* appears: no email, no
 * name, no avatar, no id -- ours or Clerk's. The handle is the identity, and it
 * is the one they chose to publish.
 */
export type PublicProfileCard = {
  id: string
  name: string
  issuer: string
  bank: { id: string; name: string }
}

export type PublicProfile = {
  handle: string
  score: number
  maxScore: number
  tier: Tier
  cardCount: number
  cards: PublicProfileCard[]
}

/**
 * Built by naming each field rather than spreading and deleting: a field added
 * to the card or the wallet later cannot leak through a projection that has to
 * be edited to carry it.
 */
export function toPublicProfile(handle: string, wallet: StoredWallet): PublicProfile {
  return {
    handle,
    score: wallet.score.score,
    maxScore: wallet.score.maxScore,
    tier: wallet.score.tier,
    cardCount: wallet.score.cardCount,
    cards: wallet.cards.map((entry) => ({
      id: entry.card.id,
      name: entry.card.name,
      issuer: entry.card.issuer,
      bank: { id: entry.card.bank.id, name: entry.card.bank.name },
    })),
  }
}
```

- [ ] **Step 4: Write the route**

Create `backend/src/modules/profiles/routes.ts`:

```ts
import { Hono } from 'hono'
import type { AppEnv } from '../../env'
import { ApiError } from '../../http/errors'
import { getUserByHandle } from '../users/queries'
import { HANDLE_PATTERN } from '../users/userTypes'
import { getVerifiedWallet } from '../wallet/queries'
import { toPublicProfile } from './profileTypes'

/**
 * The public face of a wallet, and the only unauthenticated read of anybody's
 * data in this API.
 *
 * A module of its own rather than a route on /v1/users, whose docstring says it
 * never returns anyone else's row -- and it still does not. What this returns
 * is a projection, and keeping it here is what makes that distinction something
 * you can see from the URL rather than something you have to trust.
 *
 * There is no queries.ts: this module owns no tables. It calls
 * users.getUserByHandle and wallet.getVerifiedWallet, per the rule in
 * README.md that no module writes SQL against another's tables.
 */
export const profileRoutes = new Hono<AppEnv>()

profileRoutes.get('/:handle', async (c) => {
  const handle = c.req.param('handle').trim().toLowerCase()

  // A malformed handle cannot match a row -- the CHECK forbids storing one --
  // so this is a 404 rather than a 400. There is nothing to correct: no such
  // profile exists and none ever could.
  if (!HANDLE_PATTERN.test(handle)) throw ApiError.notFound(`Profile '${handle}'`)

  const user = await getUserByHandle(c.env.DB, handle)
  // A deactivated user is gone as far as the public is concerned. Their wallet
  // is intact and comes back with them if Clerk un-deletes them.
  if (!user || !user.isActive) throw ApiError.notFound(`Profile '${handle}'`)

  const wallet = await getVerifiedWallet(c.env.DB, user.id)
  return c.json(toPublicProfile(user.handle ?? handle, wallet))
})
```

- [ ] **Step 5: Mount it**

In `backend/src/index.ts`, add the import:

```ts
import { profileRoutes } from './modules/profiles/routes'
```

and the mount, after the `/v1/handles` line:

```ts
app.route('/v1/profiles', profileRoutes)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && npx vitest run test/profiles.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Run the full suite, typecheck and commit**

Run: `cd backend && npm run typecheck && npm test`

```bash
git add backend/src/modules/profiles backend/src/index.ts backend/test/profiles.test.ts
git commit -m "feat(profiles): a public profile behind a handle

The only unauthenticated read of a person's data in this API, so it gets its
own module and a projection written field by field -- a field added to the
card or the wallet later cannot leak through something that has to be edited
to carry it. No email, name, avatar or id, ours or Clerk's.

Not a route on /v1/users, whose invariant is that it never returns anyone
else's row. It still does not: this returns a projection, and the URL is
where that distinction should be visible."
```

---

### Task 6: The frontend knows about handles

The API client, the shape-only validator, and hydrating the handle at sign-in.
One deliverable: the app can ask about handles and knows its own.

**Files:**
- Modify: `frontend/src/data/api.ts`
- Modify: `frontend/src/data/handles.ts`
- Modify: `frontend/src/auth/useClerkUserSync.ts`

**Interfaces:**
- Consumes: `request`, `Me` from `api.ts`.
- Produces: `Me.handle: string | null`; `checkHandleAvailability(handle: string, signal?: AbortSignal): Promise<boolean>`; `claimHandle(handle: string): Promise<Me>`; `fetchProfile(handle: string, signal?: AbortSignal): Promise<PublicProfile>` and `type PublicProfile` from `api.ts`. From `handles.ts`: `HandleShape = 'empty' | 'invalid' | 'short' | 'long' | 'ok'` and `checkHandleShape(raw: string): { normalized: string; shape: HandleShape; message: string; valid: boolean }`.

- [ ] **Step 1: Extend the API client**

In `frontend/src/data/api.ts`, add `handle` to the `Me` type:

```ts
export type Me = {
  id: string
  email: string | null
  name: string | null
  imageUrl: string | null
  isActive: boolean
  isAdmin: boolean
  /** The claimed public handle, or null. */
  handle: string | null
}
```

and append a handles section after the identity block:

```ts
/* --------------------------------------------------------------- handles */

/**
 * Whether claiming would succeed. Never throws for a bad handle -- the endpoint
 * answers `false` rather than erroring, so this can run on every keystroke.
 */
export async function checkHandleAvailability(
  handle: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const body = await request<{ handle: string; available: boolean }>(
    `/v1/handles/${encodeURIComponent(handle)}`,
    { signal },
  )
  return body.available
}

/**
 * Claims or changes the caller's handle. A 409 means somebody took it between
 * the availability check and this call, or that nothing is verified yet.
 */
export function claimHandle(handle: string): Promise<Me> {
  return request<Me>('/v1/users/me/handle', {
    method: 'PUT',
    body: JSON.stringify({ handle }),
  })
}

/* -------------------------------------------------------------- profiles */

export type PublicProfileCard = {
  id: string
  name: string
  issuer: string
  bank: { id: string; name: string }
}

export type PublicProfile = {
  handle: string
  score: number
  maxScore: number
  tier: Tier
  cardCount: number
  cards: PublicProfileCard[]
}

/** Public: no session required, and a 404 means nobody holds that handle. */
export function fetchProfile(handle: string, signal?: AbortSignal): Promise<PublicProfile> {
  return request<PublicProfile>(`/v1/profiles/${encodeURIComponent(handle)}`, { signal })
}
```

- [ ] **Step 2: Make the local check shape-only**

Replace `frontend/src/data/handles.ts` entirely:

```ts
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
  return result('ok', 'Checking…')
}
```

- [ ] **Step 3: Hydrate the handle at sign-in**

In `frontend/src/auth/useClerkUserSync.ts`, add the import:

```ts
import { fetchMe } from '../data/api'
```

and append a second effect inside the hook, after the existing one:

```ts
  // The handle lives on the server, not in this browser. Without this, signing
  // in on a second device looks like you never claimed one -- Redux is
  // populated from localStorage, which is per-browser by definition.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return

    const controller = new AbortController()

    fetchMe(controller.signal)
      .then((profile) => {
        if (profile.handle) dispatch(walletActions.claimHandle(profile.handle))
      })
      .catch(() => {
        // Not fatal. The claim screen re-checks against the server anyway, and
        // a failure here only means the handle is not shown until next load.
      })

    return () => controller.abort()
  }, [dispatch, isLoaded, isSignedIn])
```

- [ ] **Step 4: Verify**

Run: `cd frontend && npx tsc -b`
Expected: FAIL — `ClaimHandlePage` still imports `checkHandle`, which no longer
exists. That is Task 7; this step confirms the only breakage is the expected one.

- [ ] **Step 5: Commit together with Task 7**

This task leaves the build red on purpose, so it is committed with the screen
that consumes it. No commit here.

---

### Task 7: The claim screen claims

**Files:**
- Modify: `frontend/src/pages/ClaimHandlePage.tsx`

**Interfaces:**
- Consumes: `checkHandleShape`, `HANDLE_MAX`, `HANDLE_MIN` (Task 6); `checkHandleAvailability`, `claimHandle`, `ApiError` (Task 6).
- Produces: nothing.

- [ ] **Step 1: Rewrite the page body**

In `frontend/src/pages/ClaimHandlePage.tsx`, replace the imports of `checkHandle`
with:

```ts
import { ApiError } from '../data/api'
import { checkHandleAvailability, claimHandle } from '../data/api'
import { checkHandleShape, HANDLE_MAX, HANDLE_MIN } from '../data/handles'
```

Replace everything from `const check = checkHandle(handle)` down to the closing
`</Screen>` with:

```tsx
  const check = checkHandleShape(handle)

  // 'unknown' until the server answers. Keyed to the handle it describes, so a
  // late reply for a name that has since been edited is ignored rather than
  // shown against the new one.
  const [availability, setAvailability] = useState<{ handle: string; free: boolean } | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const candidate = check.valid ? check.normalized : ''

  useEffect(() => {
    if (candidate === '') return

    const controller = new AbortController()
    // Same shape as useWalletScore: debounce, and abort the in-flight request
    // on cleanup so a fast typist does not queue a dozen answers.
    const timer = setTimeout(() => {
      checkHandleAvailability(candidate, controller.signal)
        .then((free) => setAvailability({ handle: candidate, free }))
        .catch(() => {
          /* Offline or aborted. The claim itself is the real check. */
        })
    }, 250)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [candidate])

  const answered = availability?.handle === candidate ? availability : null
  const free = answered?.free ?? false
  const canClaim = check.valid && free && !claiming

  const message = error
    ? error
    : !check.valid
      ? check.message
      : answered === null
        ? 'Checking…'
        : free
          ? 'Available'
          : 'Taken. Try adding a number or an underscore.'

  const good = check.valid && free && error === null
  const color =
    check.shape === 'empty'
      ? 'rgba(255,255,255,0.35)'
      : !check.valid || error
        ? '#F87171'
        : answered === null
          ? 'rgba(255,255,255,0.55)'
          : free
            ? '#34D399'
            : '#F87171'
  const borderColor =
    check.shape === 'empty'
      ? 'rgba(255,255,255,0.12)'
      : good
        ? 'rgba(52,211,153,0.5)'
        : 'rgba(248,113,113,0.5)'

  const submit = async () => {
    setClaiming(true)
    setError(null)
    try {
      const claimed = await claimHandle(check.normalized)
      dispatch(walletActions.claimHandle(claimed.handle ?? check.normalized))
      navigate({ kind: 'profile', username: claimed.handle ?? check.normalized })
    } catch (err) {
      // A 409 between the availability check and here is the whole reason this
      // renders in place rather than navigating optimistically.
      setError(
        err instanceof ApiError
          ? (err.details?.[0] ?? err.message)
          : 'Could not claim that handle.',
      )
      setAvailability({ handle: candidate, free: false })
    } finally {
      setClaiming(false)
    }
  }

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <h2 className={styles.title}>Pick your handle</h2>
      <p className={styles.blurb}>This becomes your public profile address.</p>

      <div className={styles.panel}>
        <div className={styles.label}>Your URL</div>
        <div className={styles.url}>
          <span className={styles.domain}>{PROFILE_PREFIX}</span>
          <span style={{ color }}>{check.normalized || 'yourname'}</span>
        </div>

        <div className={styles.field} style={{ borderColor }}>
          <input
            className={styles.input}
            value={handle}
            onChange={(e) => {
              setHandle(e.target.value)
              setError(null)
            }}
            placeholder="yourname"
            aria-label="Your handle"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={HANDLE_MAX}
          />
          <span className={styles.icon} style={{ color }} aria-hidden="true">
            {check.shape === 'empty' || (check.valid && answered === null) ? '' : good ? '✓' : '✕'}
          </span>
        </div>
        <div className={styles.message} style={{ color }} role="status">
          {message}
        </div>
      </div>

      <div className={styles.footer}>
        <Button disabled={!canClaim} onClick={submit}>
          {claiming ? 'Claiming…' : 'Claim handle'}
        </Button>
        <div className={styles.footnote}>
          Letters, numbers and underscores. {HANDLE_MIN}–{HANDLE_MAX} characters.
        </div>
      </div>
    </Screen>
  )
}
```

- [ ] **Step 2: Verify**

Run: `cd frontend && npx tsc -b && npm run lint && npm run build`
Expected: all three clean.

- [ ] **Step 3: Commit Tasks 6 and 7 together**

```bash
git add frontend/src/data/api.ts frontend/src/data/handles.ts \
        frontend/src/auth/useClerkUserSync.ts frontend/src/pages/ClaimHandlePage.tsx
git commit -m "feat(handles): claim a handle against the server

Availability moves out of the client, where it was checked against five names
transcribed from the design and two people could both be told a name was
free. The local check is shape only; the server answers the rest, debounced
per keystroke and keyed to the handle it describes so a late reply for an
edited name is discarded.

The claim renders a 409 in place rather than navigating, because somebody can
take the handle between the check and the claim and that has to be visible.

useClerkUserSync hydrates the handle from /v1/users/me: it lives on the
server, and Redux is populated from localStorage, which is per-browser."
```

---

### Task 8: A real profile, and the docs

The profile page stops inventing data, `demoProfile.ts` goes, and the docs catch
up.

**Files:**
- Modify: `frontend/src/pages/ProfilePage.tsx`
- Delete: `frontend/src/data/demoProfile.ts`
- Modify: `backend/README.md`
- Modify: `frontend/README.md`
- Modify: `docs/superpowers/specs/2026-09-01-public-handles-design.md`

**Interfaces:**
- Consumes: `fetchProfile`, `PublicProfile` (Task 6).
- Produces: nothing.

- [ ] **Step 1: Fetch a real profile**

In `frontend/src/pages/ProfilePage.tsx`, drop the `demoProfile` import and add:

```ts
import { useEffect, useState } from 'react'
import { fetchProfile } from '../data/api'
import type { PublicProfile } from '../data/api'
```

Replace the `const demo = demoProfile(username)` line and the `view` expression
with:

```tsx
  // Your own profile renders from local state, so it is instant and correct
  // while a claim is still settling. Anyone else's comes from the API.
  const own = state.handle === username

  const [fetched, setFetched] = useState<PublicProfile | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (own) return

    const controller = new AbortController()
    setMissing(false)

    fetchProfile(username, controller.signal)
      .then(setFetched)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setMissing(true)
      })

    return () => controller.abort()
  }, [own, username])

  const view: ProfileView | null = own
    ? {
        handle: username,
        rating,
        tier: score.tier,
        verifiedCount: verifiedCards.length,
        summary: summaryFor(rating, verifiedCards.length),
        cards: verifiedCards,
        isOwn: true,
      }
    : fetched
      ? {
          handle: fetched.handle,
          rating: fetched.score,
          tier: fetched.tier,
          verifiedCount: fetched.cardCount,
          summary: summaryFor(fetched.score, fetched.cardCount),
          // The public payload carries no fee or selectability, and the deck
          // does not render them.
          cards: fetched.cards.map((card) => ({
            id: card.id,
            name: card.name,
            issuer: card.issuer,
            short: `${card.bank.name}\n${card.name}`,
            joiningFee: 0,
            annualFee: 0,
            selectable: true,
          })),
          isOwn: false,
        }
      : null
```

Then change the `if (!view)` guard so a pending fetch is not mistaken for a
missing profile:

```tsx
  if (!view) {
    // A fetch still in flight is not a missing profile. Rendering the empty
    // screen here rather than the copy below is what stops "No wallet here
    // yet" flashing on every profile that does exist.
    if (!missing) return <Screen glows={GLOWS} className={styles.missing} />

    /* Leave the existing `return (<Screen …>No wallet here yet…</Screen>)`
       block that already follows this guard exactly as it is — only the two
       lines above are new. */
  }
```

- [ ] **Step 2: Delete the mock**

```bash
git rm frontend/src/data/demoProfile.ts
```

Its docstring says it stands in "until public profiles are a real endpoint."
They are now, so `#/u/arjun` 404s until somebody claims `arjun`.

- [ ] **Step 3: Verify**

Run: `cd frontend && npx tsc -b && npm run lint && npm run build`
Expected: all three clean, and no reference to `demoProfile` survives:

```bash
grep -rn "demoProfile\|DEMO_PROFILES\|TAKEN_HANDLES" frontend/src || echo "clean"
```

- [ ] **Step 4: Correct the spec and update both READMEs**

In `docs/superpowers/specs/2026-09-01-public-handles-design.md`, the errors table
lists a reserved handle as a 409. It is a 400 from the validator — a bad value,
not a race. Change that row to:

```
| Reserved handle on claim | 400, with `details` naming it as reserved |
| Already taken | 409 |
```

In `backend/README.md`, add to the route table:

```
| `PUT` | `/v1/users/me/handle` | session — claims or changes the public handle |
| `GET` | `/v1/handles/:handle` | whether claiming would succeed |
| `GET` | `/v1/profiles/:handle` | public — somebody's score and verified cards |
```

and a short section under Auth noting that `/v1/profiles` is the one
unauthenticated read of a person's data, that the projection in
`profiles/profileTypes.ts` is the boundary, and that a renamed handle returns to
the pool.

In `frontend/README.md`, replace the "wallet is client-side only" claim about
handles: the handle is now server-owned and hydrated at sign-in.

- [ ] **Step 5: Full verification**

```bash
cd backend && npm run typecheck && npm test
cd ../frontend && npx tsc -b && npm run lint && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/ProfilePage.tsx backend/README.md frontend/README.md \
        docs/superpowers/specs/2026-09-01-public-handles-design.md
git rm --cached frontend/src/data/demoProfile.ts 2>/dev/null || true
git commit -m "feat(profiles): render a real profile behind a handle

demoProfile.ts is deleted -- its docstring said it stood in until public
profiles were a real endpoint, and they are. #/u/arjun 404s until somebody
claims arjun.

Your own profile still renders from local state so it stays instant while a
claim settles; everyone else's is fetched. A pending fetch renders empty
rather than 'No wallet here yet', which would flash the wrong answer for
every profile that does exist."
```

---

## Manual walkthrough

The frontend has no test harness, so this is its gate. Against
`cd backend && npm run dev` and `cd frontend && npm run dev`:

1. Sign in, verify a card, open `#/claim`. Type `ab` → "A little longer". Type
   `admin` → ✕ and "Taken…". Type a free name → ✓ "Available".
2. Claim it. You land on `#/u/<handle>` and it renders your wallet.
3. Open the same URL in a private window, signed out. The profile renders, and
   shows only verified cards.
4. In that window's devtools, confirm the `/v1/profiles/...` payload contains no
   email, name, avatar or id.
5. Sign in as a second account, verify a card, and try to claim the same handle
   → the message appears in place and you stay on the screen.
6. Claim a different handle, then change it. The first is claimable by the
   second account.
7. Open `#/u/arjun` → "No wallet here yet".
8. Sign out and back in. The handle is still yours — that is the `/v1/users/me`
   hydration.

## Risks

- **Freeing a renamed handle** lets a shared link resolve to a different person
  later. Deliberate; recorded in the spec with the alternative named.
- **`0014` is a schema change on `users`.** It is additive with a nullable
  column, so it is safe on a populated table, but it is applied to production by
  CI on merge.
- **`demoProfile.ts` deletion** is user-visible: `#/u/arjun` stops working.
- **The claim gate reads `wallet_cards` from the users module** via
  `countVerifiedCards`. If that function moves, the gate silently disappears —
  the test in Task 3 is what catches it.
