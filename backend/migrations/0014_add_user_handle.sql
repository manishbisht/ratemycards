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
