-- Migration number: 0008 	 2026-08-30T00:00:00.000Z
-- The wallet module's first table: which cards a signed-in person holds.
--
-- Until now a wallet was a set of card ids living in the browser, and
-- /v1/wallet/preview was a pure function over them. That stays true for
-- anonymous visitors; this table is what a wallet becomes once there is an
-- account to hang it on.
--
-- Composite primary key rather than a surrogate id, matching card_scores: a
-- row IS the (user, card) pair, and there is nothing else to address it by.

CREATE TABLE wallet_cards (
  user_id             TEXT NOT NULL REFERENCES users(id),
  card_id             TEXT NOT NULL REFERENCES cards(id),
  -- Mirrors VerificationStatus in the frontend's state/walletTypes.ts.
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verified_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (user_id, card_id),
  CHECK (verification_status IN ('unverified', 'pending', 'verified', 'failed')),
  -- A date only means something for a card that actually got verified, so the
  -- two columns cannot drift into saying different things.
  CHECK (verified_at IS NULL OR verification_status = 'verified')
);

-- Answers "who holds this card", which the wallet's own reads never ask -- they
-- are all keyed by user_id, already covered by the primary key. This exists for
-- the reverse direction a card's popularity would need.
CREATE INDEX idx_wallet_cards_card ON wallet_cards(card_id);
