-- Migration number: 0015 	 2026-09-05T00:00:00.000Z
-- Puts wallet rows back in step with the verifications behind them.
--
-- card_verifications is the durable half of a verification; wallet_cards only
-- reflects it. Removing a card deleted the reflection and left the fact, and
-- adding the card back wrote a fresh 'unverified' row -- so the wallet said a
-- card was unproved while the verification module, reading the evidence,
-- refused a second attempt at it. The card was stuck: shown unverified, offered
-- a Verify button, and answered with "already verified" every time.
--
-- queries.ts now seeds a new row from the evidence and will not let any caller
-- write a lesser status over a proof, so this cannot happen again. That fixes
-- rows written from here on; it does nothing for rows already sitting in the
-- broken state, and those are exactly the cards someone is looking at today.
-- This is that repair, done once.
--
-- ONLY UPWARDS. A row is touched only when the evidence proves the card and the
-- row disagrees. Nothing is ever demoted: an unproved card claiming 'verified'
-- is a different bug (PATCH /v1/wallet/cards/:cardId still takes the client's
-- word for a status) and quietly stripping those here would hide it rather than
-- fix it.
--
-- The date restored is when the card was first proved, not when this ran --
-- the same MIN(updated_at) that listProvedCards reads, so a healed row and a
-- re-added one carry the same stamp.

UPDATE wallet_cards
SET verification_status = 'verified',
    verified_at = (
      SELECT MIN(v.updated_at) FROM card_verifications v
      WHERE v.user_id = wallet_cards.user_id
        AND v.card_id = wallet_cards.card_id
        AND v.status = 'verified'
    ),
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE verification_status <> 'verified'
  AND EXISTS (
    SELECT 1 FROM card_verifications v
    WHERE v.user_id = wallet_cards.user_id
      AND v.card_id = wallet_cards.card_id
      AND v.status = 'verified'
  );
