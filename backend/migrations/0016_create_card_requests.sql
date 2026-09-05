-- Migration number: 0016 	 2026-09-05T00:00:00.000Z
-- Card requests: what a signed-in person asks the catalog to gain, and the
-- draft an admin corrects before it becomes a real row.
--
-- WHY A REQUEST IS NOT A CARD
-- Everything here is a CLAIM, not a fact. The issuer may be spelled three ways,
-- the network may be wrong, and a BIN prefix read off the front of somebody's
-- own plastic is a guess about a product family, not a product. So this table
-- writes NOTHING into the catalog. An admin creates the bank, the card and the
-- prefixes through the existing admin endpoints -- which already validate every
-- one of those against networks/binRules.ts -- and only then marks the request
-- resolved. Approval is bookkeeping over work that already happened, which is
-- why there is no trigger, no cascade, and no write path from here into `cards`.
--
-- ONE TABLE, TWO KINDS
-- 'card' asks for a product the catalog does not carry. 'bin' asks for prefixes
-- on a product it does. They share their owner, their status machine, their
-- review columns and both list endpoints; they differ in five columns. That is
-- the same trade network_bin_rules made in 0009, and the CHECK block below
-- carries the asymmetry the same way.
--
-- WHY card_id IS ONE COLUMN AND NOT TWO
-- It means "the catalog card this request concerns". On a 'bin' request that is
-- the target and it is set at insert. On a 'card' request it is the result and
-- it stays NULL until approval fills it in. A separate resolved_card_id would
-- hold the same value as card_id on every 'bin' row -- a second copy of one
-- fact, and a place for the two to disagree.
--
-- APPROVAL IS GATED ON EXISTENCE, NOT ON SELECTABILITY.
-- A card with no BIN prefixes is a supported state: two thirds of the seeded
-- catalog is in it. Requiring prefixes before a request could be approved would
-- wedge the queue whenever the data is not to hand, and push an admin towards
-- inventing a prefix to clear it -- straight into card_bins, which is the input
-- to the rupee verification match. So the API reports `selectable` and lets the
-- screen say "added, it will appear once we have its prefixes". Honesty here is
-- a copy problem, not a constraint problem.
--
-- reviewed_by IS NULLABLE AND THAT IS NOT AN OVERSIGHT.
-- src/http/adminAuth.ts accepts EITHER a Clerk session OR the shared
-- ADMIN_TOKEN, and on the shared-token path `c.get('user')` is undefined -- the
-- token identifies NOBODY. Every review driven from the console carries an
-- admin; every review driven by curl or by the test suite carries none. NOT
-- NULL here would mean the API could not be driven by its own documented
-- credential.
--
-- The CHECKs mirror the validators in modules/cardRequests/validate.ts, the
-- CARD_TYPES list in cards/cardTypes.ts, and the bin_prefix constraints on
-- card_bins in 0009. Change one, change the other.

CREATE TABLE card_requests (
  id            TEXT NOT NULL,                 -- 'creq_<32 hex>', minted server-side
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL,                 -- 'card' | 'bin'

  -- The catalog card this request concerns. See the note above.
  card_id       TEXT REFERENCES cards(id),

  -- kind='card' only. bank_id is set when the requester picked an issuer we
  -- already carry; bank_name is written EITHER WAY, even when bank_id resolved,
  -- because it is half the dedupe index below and SQLite treats NULLs in a
  -- unique index as distinct from each other.
  bank_id       TEXT REFERENCES banks(id),
  bank_name     TEXT,                          -- 'HDFC Bank', as adopted or as typed
  card_name     TEXT,                          -- 'Infinia Metal'
  card_type     TEXT,                          -- optional; the admin settles it

  -- A network CODE, never an id: ids do not leave the server, and this arrived
  -- from a client. Deliberately not a foreign key -- a request may name a
  -- network that is later renamed or retired, and the row must still read back.
  network_code  TEXT NOT NULL,

  -- The requester's own words, for everything the form cannot express.
  note          TEXT,

  status        TEXT NOT NULL DEFAULT 'pending',

  reviewed_by   TEXT REFERENCES users(id),     -- NULL on the ADMIN_TOKEN path
  reviewed_at   TEXT,
  review_note   TEXT,                          -- required on a rejection

  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  -- Spelled as NOT NULL plus a table-level key rather than the
  -- inline `TEXT PRIMARY KEY` the other tables use: SQLite lets a NULL into an
  -- inline TEXT primary key, and the GLOB CHECK would not catch it either, since
  -- a CHECK against NULL evaluates to NULL and passes.
  PRIMARY KEY (id),

  CHECK (id GLOB 'creq_[0-9a-f]*' AND length(id) = 37),
  CHECK (kind IN ('card', 'bin')),
  CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Mirrors CARD_TYPES in cards/cardTypes.ts and the CHECK in 0012.
  CHECK (card_type IS NULL OR card_type IN ('credit', 'debit', 'charge', 'prepaid')),
  -- Mirrors the code constraint on networks in 0009: lowercase alphanumeric.
  CHECK (NOT network_code GLOB '*[^a-z0-9]*' AND length(network_code) BETWEEN 2 AND 20),
  CHECK (note        IS NULL OR length(trim(note))        BETWEEN 1 AND 280),
  CHECK (review_note IS NULL OR length(trim(review_note)) BETWEEN 1 AND 280),

  -- A 'card' request names an issuer and a product, inside the bounds banks.name
  -- (0001) and cards.name (0002) already enforce, so a draft cannot hold a value
  -- the catalog would refuse three steps later.
  CHECK (kind <> 'card' OR (bank_name IS NOT NULL AND card_name IS NOT NULL)),
  CHECK (kind <> 'card' OR (length(trim(bank_name)) BETWEEN 1 AND 80
                        AND length(trim(card_name)) BETWEEN 1 AND 120)),

  -- A 'bin' request names an existing card and NOTHING ELSE. Spelled as an
  -- exhaustive null-out rather than trusted to the writer: this is what stops a
  -- row reading as both kinds at once.
  CHECK (kind <> 'bin' OR (card_id   IS NOT NULL
                       AND bank_id   IS NULL
                       AND bank_name IS NULL
                       AND card_name IS NULL
                       AND card_type IS NULL)),

  -- The state machine, both directions. A pending row carries no verdict; a
  -- settled row carries when it was settled -- but not necessarily by whom.
  CHECK (status <> 'pending' OR (reviewed_at IS NULL
                             AND reviewed_by IS NULL
                             AND review_note IS NULL)),
  CHECK (status =  'pending' OR reviewed_at IS NOT NULL),
  -- An approved request has to name the card it produced, or approval says
  -- nothing at all.
  CHECK (status <> 'approved' OR card_id IS NOT NULL),
  -- "Rejected" with no reason is the worst version of this feature, and this is
  -- what makes that non-negotiable rather than a habit.
  CHECK (status <> 'rejected' OR review_note IS NOT NULL)
);

-- THE DEDUPE GUARANTEE IS THESE TWO INDEXES, not a SELECT-then-INSERT. Two
-- submissions racing each other both pass any read-first check; against a unique
-- index one INSERT wins and the other raises, which queries.ts turns into a 409.
-- Same argument as idx_users_handle in 0014.
--
-- Partial on `status = 'pending'` on purpose: a rejected request must be
-- re-submittable once the reason is addressed, and an approved one has already
-- become a card.

-- One person, one open BIN request per card.
CREATE UNIQUE INDEX idx_card_requests_open_bin
  ON card_requests(user_id, card_id)
  WHERE kind = 'bin' AND status = 'pending';

-- One person, one open request per (issuer, product). NOCASE because 'HDFC' and
-- 'hdfc' are the same ask, and bank_name is written even when bank_id resolved
-- precisely so this index has a non-null column to key on.
CREATE UNIQUE INDEX idx_card_requests_open_card
  ON card_requests(user_id, bank_name COLLATE NOCASE, card_name COLLATE NOCASE)
  WHERE kind = 'card' AND status = 'pending';

-- "Your requests", newest first.
CREATE INDEX idx_card_requests_user ON card_requests(user_id, created_at);
-- The review queue, which defaults to status = 'pending'.
CREATE INDEX idx_card_requests_status ON card_requests(status, created_at);
-- "Is there already an open request against this card", asked at submit time.
CREATE INDEX idx_card_requests_card_id ON card_requests(card_id);

-- The prefixes a requester proposed. A child table rather than a delimited
-- column because the CHECKs below are the point: they are the same two that
-- guard card_bins in 0009, so a draft cannot hold a prefix the catalog would
-- refuse. A comma-joined string could only ever have been length-capped, which
-- would have made it the one column in the schema with no real constraint
-- behind its validator.
--
-- There is no cap on the row count here -- SQLite cannot count rows in a CHECK
-- -- so MAX_REQUEST_BINS in validate.ts is the only guard on that, and it is the
-- one rule in this migration with nothing underneath it.
CREATE TABLE card_request_bins (
  request_id TEXT NOT NULL REFERENCES card_requests(id),
  -- 6 or 8 digits, as in card_bins. NEVER a full card number: the form caps the
  -- input at 8 characters and the validator rejects anything longer with a
  -- message that says so, because this is the one field in the product that
  -- asks a person to read digits off their card.
  bin_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- A row IS the prefix, and this is what dedupes a request that lists one
  -- twice -- matching card_bins' own primary key.
  PRIMARY KEY (request_id, bin_prefix),
  CHECK (length(bin_prefix) IN (6, 8)),
  CHECK (NOT bin_prefix GLOB '*[^0-9]*')
);

-- No index beyond the primary key: every read of this table is by request_id,
-- which the PK's leading column already answers. And no ON DELETE CASCADE --
-- as with banks in 0002 and card_bins in 0009, withdrawing a request deletes its
-- prefixes explicitly, children first, in queries.ts.
