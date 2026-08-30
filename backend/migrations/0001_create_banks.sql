-- Migration number: 0001 	 2026-08-29T00:00:00.000Z
-- The banks module: card issuers. A bank has many cards; a card has one bank.
--
-- Must precede 0002, which adds the cards.bank_id foreign key.

CREATE TABLE banks (
  id         TEXT    PRIMARY KEY,            -- 'bank_1f0c...' , server-generated
  name       TEXT    NOT NULL,               -- 'HDFC Bank'
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (id GLOB 'bank_[0-9a-f]*' AND length(id) = 37),
  CHECK (length(trim(name)) BETWEEN 1 AND 80),
  CHECK (is_active IN (0, 1))
);

-- Ids are random and carry no meaning, so the name is what identifies a bank.
CREATE UNIQUE INDEX idx_banks_name ON banks(name);

CREATE INDEX idx_banks_active_name ON banks(is_active, name);
