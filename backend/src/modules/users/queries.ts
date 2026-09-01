import { ApiError } from '../../http/errors'
import { generateUserId } from './userTypes'
import type { ClerkIdentity, User } from './userTypes'

type UserRow = {
  id: string
  email: string | null
  name: string | null
  image_url: string | null
  is_active: number
  is_admin: number
  handle: string | null
}

const USER_COLUMNS = 'id, email, name, image_url, is_active, is_admin, handle'
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    imageUrl: row.image_url,
    isActive: row.is_active === 1,
    isAdmin: row.is_admin === 1,
    handle: row.handle,
  }
}

/**
 * Whether an address is on the ADMIN_EMAILS allowlist -- a comma-separated
 * Worker secret, the same shape as the ALLOWED_ORIGINS var.
 *
 * A secret rather than a var because this repository is public and a var lives
 * in the committed wrangler.jsonc: naming the address there would publish which
 * account owns the admin panel.
 *
 * An unset or empty allowlist grants nobody, so a half-configured deploy has no
 * admin rather than everyone.
 */
export function isAdminEmail(email: string | null, adminEmails: string | undefined): boolean {
  if (!email) return false

  const wanted = email.trim().toLowerCase()
  return (adminEmails ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry.length > 0 && entry === wanted)
}

/**
 * A Clerk identity in, our row out. Both paths into the users table -- the
 * webhook and the first authenticated request -- land here, so whichever
 * arrives first wins the insert and the other becomes an update.
 *
 * A row that Clerk previously reported deleted comes back active: the same
 * Clerk id signing in again is the same person returning, not a resurrection to
 * be blocked.
 *
 * COALESCE on the update keeps a field we already know when the newer source
 * omits it -- a session token carries fewer claims than a webhook payload, and
 * the sparser one must not blank the row.
 *
 * `is_admin` is absent from the UPDATE on purpose: it is not Clerk's to say, and
 * an upsert must never revoke it. The allowlist reconcile below is the one
 * writer.
 */
export async function upsertUserByClerkId(
  db: D1Database,
  identity: ClerkIdentity,
  adminEmails?: string,
): Promise<User> {
  const row = await db
    .prepare(
      `INSERT INTO users (id, clerk_id, email, name, image_url)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(clerk_id) DO UPDATE SET
         email      = COALESCE(excluded.email, users.email),
         name       = COALESCE(excluded.name, users.name),
         image_url  = COALESCE(excluded.image_url, users.image_url),
         is_active  = 1,
         updated_at = ${NOW}
       RETURNING ${USER_COLUMNS}`,
    )
    .bind(
      generateUserId(),
      identity.clerkId,
      identity.email ?? null,
      identity.name ?? null,
      identity.imageUrl ?? null,
    )
    .first<UserRow>()

  if (!row) throw new Error(`User for Clerk id '${identity.clerkId}' vanished during upsert`)

  const user = toUser(row)

  /**
   * Reconciled against the row's *effective* email -- the one the upsert just
   * settled -- rather than `identity.email`. That distinction is the whole
   * point: a session token usually carries no `email` claim, so checking the
   * incoming value would grant an admin on the webhook and never again.
   *
   * Grant-only. Dropping an address from the allowlist does not revoke the flag,
   * because the sparse-claims problem cuts both ways: an incoming identity with
   * no email must not be read as "not an admin". Revoke with a one-line UPDATE.
   *
   * The write happens at most once per user, ever, so the steady state is still
   * a single statement per authenticated request.
   */
  if (!user.isAdmin && isAdminEmail(user.email, adminEmails)) {
    await db
      .prepare(`UPDATE users SET is_admin = 1, updated_at = ${NOW} WHERE id = ?`)
      .bind(user.id)
      .run()
    return { ...user, isAdmin: true }
  }

  return user
}

export async function getUserByClerkId(db: D1Database, clerkId: string): Promise<User | null> {
  const row = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE clerk_id = ?`)
    .bind(clerkId)
    .first<UserRow>()
  return row ? toUser(row) : null
}

/**
 * Soft delete, matching how banks and cards retire. wallet_cards holds a
 * foreign key to users, so a hard delete would either fail or orphan someone's
 * wallet -- and a deletion Clerk later reverses would take the wallet with it.
 */
export async function deactivateUserByClerkId(db: D1Database, clerkId: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET is_active = 0, updated_at = ${NOW} WHERE clerk_id = ?`)
    .bind(clerkId)
    .run()
}

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
