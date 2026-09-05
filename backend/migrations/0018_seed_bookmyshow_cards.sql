-- Migration number: 0018 	 2026-09-05T00:00:00.000Z
-- Six cards BookMyShow publishes prefixes for, seeded DARK so their BINs have
-- somewhere to live until somebody prices and scores them.
--
-- WHY THEY ARRIVE INACTIVE, AND WHY THAT IS THE POINT.
-- A card needs a joining fee, an annual fee, and a 0-10 score against each of
-- the seven rubric criteria. None of that is in a BIN list, and inventing it is
-- not a small lie: `scoreWallet` is
--
--     620 + SUM(rating * 50) + (cards - 1) * 60
--
-- and `cardWeight(null)` is 0. An unscored card therefore contributes NOTHING to
-- a wallet while still collecting its 60-point multi-card bonus -- six of them
-- would hand anyone holding them 360 free points on a 3000 ladder, for cards the
-- rubric has never seen. is_active = 0 keeps them out of browse, out of wallets
-- and out of scoring entirely, so the prefixes can land today and the editorial
-- work can happen where it belongs: PUT /v1/cards/:id/scores and PATCH
-- /v1/cards/:id, through the admin panel, by somebody who knows the products.
--
-- THE FEES BELOW ARE PLACEHOLDER ZEROS, NOT CLAIMS. joining_fee and annual_fee
-- are NOT NULL with no third state for "unknown", so zero is the only thing this
-- migration can write. Zero means free, and none of these are; every one needs a
-- real number before it is activated. Nothing reads them while is_active = 0.
--
-- WHAT IS NOT HERE. BookMyShow publishes 245 prefixes; 103 were already on file
-- and 0017 added four. These six cards carry eleven more. The remaining 227 name
-- either a bank-level offer bucket ("HDFC / General Credit Card Offer", ninety
-- prefixes under no product at all), a group of cards no single prefix can be
-- pinned to, or a bank this catalog does not carry. Adding cards does not fix
-- any of those -- a bucket names no product, and a six-card offer still leaves
-- six candidates per prefix.
--
-- Two cards that looked like wins are absent on purpose: IDFC FIRST Private's
-- 440523 is already on Mayura and Wealth, and RBL SuperCard's prefixes are
-- already on World Safari. Both would have added a product and no information.
--
-- 'Reliance SBI' is not an issuer. It is an SBI Card co-brand, so PRIME goes
-- under SBI rather than inventing a thirteenth bank.

-- DBS is active even though its only card is not: a bank with no visible cards
-- costs nothing, and it makes DBS selectable in the card-request form, which is
-- how somebody asks for the rest of its range.
INSERT INTO banks (id, name)
SELECT 'bank_' || lower(hex(randomblob(16))), 'DBS'
WHERE NOT EXISTS (SELECT 1 FROM banks WHERE name = 'DBS');

INSERT INTO cards (id, bank_id, name, country, joining_fee, annual_fee, type, is_active)
WITH new_cards(bank, card) AS (
  VALUES
    ('Axis'          , 'Neo'),
    ('HDFC'          , 'Times Card'),
    ('Kotak'         , 'Cashback+'),
    ('Bank of Baroda', 'BOBCARD Tiara'),
    ('DBS'           , 'Vantage'),
    ('SBI'           , 'Reliance PRIME')
)
SELECT 'card_' || lower(hex(randomblob(16))), b.id, new_cards.card, 'IN', 0, 0, 'credit', 0
FROM new_cards
JOIN banks b ON b.name = new_cards.bank
WHERE NOT EXISTS (
  SELECT 1 FROM cards c WHERE c.bank_id = b.id AND c.name = new_cards.card
);

INSERT INTO card_networks (card_id, network_id)
WITH nets(bank, card, network) AS (
  VALUES
    ('Axis'          , 'Neo'            , 'visa'      ),
    ('Axis'          , 'Neo'            , 'mastercard'),
    ('Axis'          , 'Neo'            , 'rupay'     ),
    ('HDFC'          , 'Times Card'     , 'mastercard'),
    ('HDFC'          , 'Times Card'     , 'visa'      ),
    ('Kotak'         , 'Cashback+'      , 'visa'      ),
    ('Kotak'         , 'Cashback+'      , 'jcb'       ),
    ('Bank of Baroda', 'BOBCARD Tiara'  , 'jcb'       ),
    ('DBS'           , 'Vantage'        , 'visa'      ),
    ('SBI'           , 'Reliance PRIME' , 'jcb'       )
)
SELECT c.id, n.id
FROM nets
JOIN banks b    ON b.name = nets.bank
JOIN cards c    ON c.bank_id = b.id AND c.name = nets.card
JOIN networks n ON n.code = nets.network
WHERE NOT EXISTS (
  SELECT 1 FROM card_networks e WHERE e.card_id = c.id AND e.network_id = n.id
);

INSERT INTO card_bins (card_id, network_id, bin_prefix)
WITH bins(bank, card, network, bin_prefix) AS (
  VALUES
    -- offers/axis-bank-neo-and-indian-oil-credit-card-offer/AXSIN0324
    ('Axis'          , 'Neo'            , 'visa'      , '464118'),
    ('Axis'          , 'Neo'            , 'mastercard', '530562'),
    ('Axis'          , 'Neo'            , 'rupay'     , '653047'),
    -- offers/hdfc-bank-timescard-offer/HTCCC0324
    ('HDFC'          , 'Times Card'     , 'mastercard', '524181'),
    ('HDFC'          , 'Times Card'     , 'mastercard', '522852'),
    ('HDFC'          , 'Times Card'     , 'visa'      , '416317'),
    -- kotak.bank.in/bank/mailers/2026/files/BMS T&C.pdf
    ('Kotak'         , 'Cashback+'      , 'visa'      , '416645'),
    ('Kotak'         , 'Cashback+'      , 'jcb'       , '356164'),
    -- offers/bank-of-baroda-credit-card-offer/RPBOB0325
    ('Bank of Baroda', 'BOBCARD Tiara'  , 'jcb'       , '356189'),
    -- offers/dbs-bank-vantage-credit-card-offer/DBSVN0424
    ('DBS'           , 'Vantage'        , 'visa'      , '476137'),
    -- offers/reliance-sbi-card-prime/SBIRLC1123
    ('SBI'           , 'Reliance PRIME' , 'jcb'       , '356177')
)
SELECT c.id, n.id, bins.bin_prefix
FROM bins
JOIN banks b    ON b.name = bins.bank
JOIN cards c    ON c.bank_id = b.id AND c.name = bins.card
JOIN networks n ON n.code = bins.network
WHERE NOT EXISTS (
  SELECT 1 FROM card_bins e WHERE e.card_id = c.id AND e.bin_prefix = bins.bin_prefix
);
