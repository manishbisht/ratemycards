-- Migration number: 0007 	 2026-08-30T00:00:00.000Z
-- The users module: who is behind a session.
--
-- Rows arrive two ways, both landing on the same upsert: the Clerk webhook
-- (primary) and, as a backstop, the first authenticated request a user makes.
-- A dropped webhook therefore self-heals instead of leaving a hole.
--
-- `id` and `clerk_id` both start with 'user_' but are not interchangeable:
-- ours is 32 lowercase hex, Clerk's is mixed-case base58 of no fixed length.
-- Everything downstream -- wallet_cards especially -- keys off `id`, so the
-- identity provider stays swappable.

CREATE TABLE users (
  id         TEXT    PRIMARY KEY,            -- 'user_1f0c...' , server-generated
  clerk_id   TEXT    NOT NULL,               -- 'user_2abC...' , from Clerk
  email      TEXT,                           -- primary address, absent for some SSO setups
  name       TEXT,                           -- display name, may be missing
  image_url  TEXT,                           -- avatar, may be missing
  is_active  INTEGER NOT NULL DEFAULT 1,     -- 0 once Clerk reports the user deleted
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (id GLOB 'user_[0-9a-f]*' AND length(id) = 37),
  CHECK (length(trim(clerk_id)) BETWEEN 1 AND 120),
  CHECK (email IS NULL OR length(email) <= 320),
  CHECK (name IS NULL OR length(name) <= 120),
  CHECK (image_url IS NULL OR length(image_url) <= 2048),
  CHECK (is_active IN (0, 1))
);

-- The natural key. Also the conflict target the upsert depends on, so this
-- index is load-bearing rather than only an optimisation.
CREATE UNIQUE INDEX idx_users_clerk_id ON users(clerk_id);
