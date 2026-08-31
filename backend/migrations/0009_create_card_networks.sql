-- Migration number: 0009 	 2026-08-30T00:00:00.000Z
-- The networks module: the payment networks a card can be issued on, the BIN
-- prefix rules each network allocates under, and which of those a given card
-- actually runs on.
--
-- This is the migration 0002 promised ("Networks ... arrive in a later
-- migration"). 0002 is applied and therefore immutable, so its stale comment is
-- left alone.
--
-- WHY A CARD HAS A PARTICULAR BIN
-- The leading digits of a card number are the IIN (Issuer Identification
-- Number), universally called the BIN -- ISO/IEC 7812, historically 6 digits,
-- officially 8 since 2022. It is allocated in three nested layers:
--
--   1. Digit 1 is the Major Industry Identifier, which is why every Visa
--      starts 4, every Amex 34 or 37, and so on.
--   2. Digits 1-8 are the block the network allocated to one issuer. HDFC's
--      Visa credit block is not ICICI's.
--   3. Within its block the issuer sub-allocates ranges per product: funding
--      type, consumer vs commercial, and tier.
--
-- At authorization the acquirer sees only the card number, so the BIN is what
-- tells it which network to route to and which issuer to ask.
--
-- TWO ASYMMETRIES WORTH KNOWING BEFORE BUILDING ON THIS
-- A 6-digit BIN usually identifies issuer + network + product *family*, not one
-- product, so two cards may legitimately share a prefix: BIN -> card is
-- many-to-many, and there is deliberately no UNIQUE on bin_prefix.
-- And prefix -> network is ambiguous in the other direction (65 is both RuPay
-- and Discover; 81 both RuPay and UnionPay), which is why a card's network is
-- stored rather than derived. Only network -> allowed prefixes is a function,
-- and that is the direction network_bin_rules expresses.
--
-- WHY THE PREFIX RULES ARE ROWS AND NOT A CHECK
-- An earlier draft of this migration held the whole ISO/IEC 7812 prefix table
-- in one CHECK on card_bins, so no write path could bypass it. That stops
-- working the moment networks become rows an admin can add: a CHECK cannot
-- subquery a table. The rules therefore live in network_bin_rules and are
-- enforced by modules/networks/binRules.ts, reached from cards/validate.ts.
-- What stays in SQL is everything that does not need the lookup.

CREATE TABLE networks (
  id         TEXT    PRIMARY KEY,            -- 'network_1f0c...', server-generated
  code       TEXT    NOT NULL,               -- 'visa' -- the value the API speaks
  name       TEXT    NOT NULL,               -- 'Visa'
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (id GLOB 'network_[0-9a-f]*' AND length(id) = 40),
  -- Lowercase alphanumeric, so a code is safe in a query string and stable as a
  -- wire value.
  CHECK (NOT code GLOB '*[^a-z0-9]*' AND length(code) BETWEEN 2 AND 20),
  CHECK (length(trim(name)) BETWEEN 1 AND 40),
  CHECK (is_active IN (0, 1))
);

-- Ids are random and carry no meaning, so the code is what identifies a network.
CREATE UNIQUE INDEX idx_networks_code        ON networks(code);
CREATE INDEX        idx_networks_active_name ON networks(is_active, name);

CREATE TABLE network_bin_rules (
  network_id TEXT NOT NULL REFERENCES networks(id),
  kind       TEXT NOT NULL,                  -- 'glob' | 'range'
  value      TEXT NOT NULL,                  -- '4*'   | '2221-2720'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- A row IS the rule; there is nothing else to address it by.
  PRIMARY KEY (network_id, kind, value),
  CHECK (kind IN ('glob', 'range')),
  -- A glob may contain only digits, '[', ']', '-' and '*'. This constraint is
  -- what makes translating it straight to a RegExp in binRules.ts safe: no
  -- regex metacharacter survives it. Verified against every glob this
  -- migration's predecessor used, and against '4|5*', '4^5*', '4$*', '4+*',
  -- '4.*', '4\d*', '4(a)*' and '4 *', all rejected.
  CHECK (kind = 'range' OR NOT value GLOB '*[^]0-9[*-]*'),
  -- A range is 4-digit inclusive bounds compared against the prefix's first
  -- four digits -- the one form globs could not express (Mastercard's
  -- 2221-2720, JCB's 3528-3589).
  CHECK (kind = 'glob'  OR value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]')
);

CREATE TABLE card_networks (
  card_id    TEXT NOT NULL REFERENCES cards(id),
  network_id TEXT NOT NULL REFERENCES networks(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- A row IS the (card, network) pair, matching card_scores and wallet_cards.
  PRIMARY KEY (card_id, network_id)
);

-- Answers "which cards run on Visa", which the ?network= filter asks. The other
-- direction is already covered by the primary key.
CREATE INDEX idx_card_networks_network_id ON card_networks(network_id);

CREATE TABLE card_bins (
  card_id    TEXT NOT NULL,
  network_id TEXT NOT NULL,
  -- 6 or 8 digits. 6 is the historical IIN width and still what most public
  -- sources publish; 8 is the current ISO/IEC 7812 width.
  bin_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- One row per prefix per card: within a single card a prefix belongs to
  -- exactly one network. Two *different* cards may share a prefix, because a
  -- 6-digit BIN often identifies a product family rather than a product -- so
  -- this is not UNIQUE(bin_prefix), on purpose.
  PRIMARY KEY (card_id, bin_prefix),
  -- A BIN cannot claim a network the card does not run on. The parent is
  -- card_networks' primary key, so this needs no extra index. No ON DELETE
  -- CASCADE: as with banks in 0002, dropping a network out from under its BINs
  -- should fail loudly rather than silently destroy them. The card write path
  -- deletes BINs before their network row, in that order, deliberately.
  FOREIGN KEY (card_id, network_id) REFERENCES card_networks(card_id, network_id),
  CHECK (length(bin_prefix) IN (6, 8)),
  CHECK (NOT bin_prefix GLOB '*[^0-9]*')
);

-- For the "these digits -> which cards" lookup, which searches by prefix across
-- every card rather than within one.
CREATE INDEX idx_card_bins_prefix ON card_bins(bin_prefix);
