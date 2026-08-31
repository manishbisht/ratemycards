-- Migration number: 0012 	 2026-08-31T00:00:00.000Z
-- What kind of card this is. Credit for now: it is the whole of the launch
-- catalog and the only kind the scoring rubric was written for.
--
-- ALTER TABLE ADD COLUMN can carry a CHECK, and SQLite enforces it -- unlike
-- adding a constraint to a column that already exists, which needs a full table
-- rebuild. 0002 is applied and immutable, so this is the only way the enum gets
-- to be DB-enforced rather than validator-only.
--
-- The default is what makes this safe on a populated table: every one of the
-- 100 cards seeded by 0005 is a credit card.

ALTER TABLE cards ADD COLUMN type TEXT NOT NULL DEFAULT 'credit'
  CHECK (type IN ('credit', 'debit', 'charge', 'prepaid'));
