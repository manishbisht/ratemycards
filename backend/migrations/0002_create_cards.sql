-- Migration number: 0002 	 2026-08-29T00:00:00.000Z
-- The cards module: the catalog of every card the platform supports.
--
-- `country` stays on the card, not the bank: it is the market the card is
-- issued into, and an issuer like HSBC operates in several.
--
-- Networks (Visa / Mastercard / RuPay and their variants) are deliberately not
-- modelled yet -- they arrive in a later migration.

CREATE TABLE cards (
  id         TEXT    PRIMARY KEY,            -- 'card_1f0c...' , server-generated
  bank_id    TEXT    NOT NULL REFERENCES banks(id),
  name       TEXT    NOT NULL,               -- 'Infinia'
  country    TEXT    NOT NULL,               -- ISO 3166-1 alpha-2, e.g. 'IN'
  -- Whole units of the card's local currency (rupees for country 'IN'), not
  -- minor units: every published fee is a whole number.
  joining_fee INTEGER NOT NULL DEFAULT 0,
  annual_fee  INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (id GLOB 'card_[0-9a-f]*' AND length(id) = 37),
  CHECK (length(trim(name)) BETWEEN 1 AND 120),
  CHECK (length(country) = 2),
  CHECK (joining_fee >= 0 AND joining_fee <= 10000000),
  CHECK (annual_fee  >= 0 AND annual_fee  <= 10000000),
  CHECK (is_active IN (0, 1))
);

-- No ON DELETE CASCADE: banks are soft-deleted, and a hard delete of a bank
-- that still has cards should fail loudly rather than silently destroy them.

-- One card name per bank. This is what stops the same card being added twice.
CREATE UNIQUE INDEX idx_cards_bank_name ON cards(bank_id, name);

CREATE INDEX idx_cards_bank_id     ON cards(bank_id);
CREATE INDEX idx_cards_country     ON cards(country);
CREATE INDEX idx_cards_active_name ON cards(is_active, name);
