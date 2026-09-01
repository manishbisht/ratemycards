-- Migration number: 0013 	 2026-09-01T00:00:00.000Z
-- Whether this user may drive the admin panel.
--
-- Until now "admin" was not a person at all: it was the shared ADMIN_TOKEN
-- bearer secret in http/adminAuth.ts, with no identity behind it and no way for
-- a browser to present it (a VITE_* value is baked into the public bundle, so
-- the secret can never ship to the frontend). This column is what lets a Clerk
-- session stand in for that secret. The token still works, for curl and scripts.
--
-- NO EMAIL IS NAMED HERE, DELIBERATELY. The obvious move is to seed the flag
-- with `UPDATE users SET is_admin = 1 WHERE email = '...'`, but this repository
-- is public: that line would publish which address owns the admin account, and
-- git history would keep publishing it after any later edit. The grant instead
-- comes from the ADMIN_EMAILS Worker *secret*, reconciled against the row in
-- users/queries.ts on every upsert -- which also means it self-heals a wiped
-- database rather than needing this migration re-run by hand.
--
-- ALTER TABLE ADD COLUMN can carry a CHECK and SQLite enforces it, the same
-- trick 0012 uses; 0007 is applied and immutable, so this is the only way the
-- flag gets to be DB-enforced rather than validator-only.
--
-- Defaulting to 0 is what makes this safe on a populated table: nobody is an
-- admin until the allowlist says so.

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0
  CHECK (is_admin IN (0, 1));
