-- Migration number: 0011 	 2026-08-30T00:00:00.000Z
-- Card verification attempts: the audit trail behind wallet_cards.
--
-- Until now PATCH /v1/wallet/cards/:cardId took the client's word for whether a
-- card was verified -- the README says so. This table is what replaces that
-- trust: a card becomes 'verified' only because a row here says a real payment
-- was made on a card whose network matched, and that row is the evidence.
--
-- WHY A PAYMENT AT ALL
-- Holding a card is not something an API can be told, only shown. A 1-rupee
-- authorisation on the real card is the cheapest available proof: the person has
-- to hold the physical card and pass the issuer's own 3DS challenge.
--
-- WHY THE MONEY COMES BACK
-- The order is created with payment_capture = 0, so the rupee is authorised and
-- never captured. Razorpay voids an uncaptured authorisation after 3-5 days, and
-- an uncaptured payment attracts no MDR. `release_state` records which way each
-- one actually went, because an account configured for auto-capture will capture
-- anyway and then the only way back is a refund -- whose fee is NOT reversed.
--
-- WHAT THIS TABLE CANNOT PROVE
-- Razorpay never reports the card's BIN. The payment's card entity carries
-- last4, network, type and issuer, and that is the most the confirm step can
-- check. A BIN identifies issuer + network + tier anyway (see 0009), so
-- verification is honest at exactly the resolution the BIN data has -- "this is
-- an HDFC Visa credit card", never "this is specifically an Infinia".

CREATE TABLE card_verifications (
  id                  TEXT    PRIMARY KEY,   -- 'ver_1f0c...' , server-generated
  user_id             TEXT    NOT NULL REFERENCES users(id),
  card_id             TEXT    NOT NULL REFERENCES cards(id),

  -- Razorpay's ids. The order is minted before Checkout opens; the payment id
  -- arrives with the callback.
  razorpay_order_id   TEXT    NOT NULL,
  razorpay_payment_id TEXT,

  -- Paise. 100 is Razorpay's own floor, which it enforces server-side too.
  amount              INTEGER NOT NULL DEFAULT 100,

  status              TEXT    NOT NULL DEFAULT 'created',
  -- Why a 'mismatched' or 'failed' attempt ended that way, for support.
  failure_reason      TEXT,

  -- What Razorpay said about the card actually presented. Kept even on a
  -- mismatch: it is the whole evidence for the decision. `card_last4` is the
  -- only fragment of a card number that may be stored under PCI-DSS, and the
  -- full number never reaches this Worker at all -- Checkout collects it.
  card_network        TEXT,
  card_last4          TEXT,
  card_type           TEXT,
  card_issuer         TEXT,

  -- 'voided'   -- left uncaptured, Razorpay releases it. The no-fee path.
  -- 'refunded' -- was captured, so refunded explicitly. Costs the MDR.
  -- 'pending'  -- release not attempted or not yet resolved.
  release_state       TEXT    NOT NULL DEFAULT 'pending',

  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  CHECK (id GLOB 'ver_[0-9a-f]*' AND length(id) = 36),
  CHECK (amount >= 100),
  CHECK (status IN ('created', 'verified', 'mismatched', 'failed')),
  CHECK (release_state IN ('pending', 'voided', 'refunded')),
  CHECK (card_last4 IS NULL OR (length(card_last4) = 4 AND NOT card_last4 GLOB '*[^0-9]*')),
  -- A verified row has to name the payment that earned it.
  CHECK (status <> 'verified' OR razorpay_payment_id IS NOT NULL)
);

-- The replay guard, and the reason this is a UNIQUE INDEX rather than a plain
-- one: without it a single successful 1-rupee payment could be replayed against
-- every card in the catalog. One payment verifies one card, once.
CREATE UNIQUE INDEX idx_card_verifications_payment
  ON card_verifications(razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

-- Orders are minted one per attempt, so this is unique too -- and it is the
-- lookup the confirm step uses to find the attempt a callback belongs to.
CREATE UNIQUE INDEX idx_card_verifications_order ON card_verifications(razorpay_order_id);

-- "has this person already verified this card", and the support view.
CREATE INDEX idx_card_verifications_user_card ON card_verifications(user_id, card_id);
