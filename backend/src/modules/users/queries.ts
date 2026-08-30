import { generateUserId } from './userTypes'
import type { ClerkIdentity, User } from './userTypes'

type UserRow = {
  id: string
  email: string | null
  name: string | null
  image_url: string | null
  is_active: number
}

const USER_COLUMNS = 'id, email, name, image_url, is_active'
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    imageUrl: row.image_url,
    isActive: row.is_active === 1,
  }
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
 */
export async function upsertUserByClerkId(db: D1Database, identity: ClerkIdentity): Promise<User> {
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
  return toUser(row)
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
