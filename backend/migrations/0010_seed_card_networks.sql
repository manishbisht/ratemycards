-- Migration number: 0010 	 2026-08-30T00:00:00.000Z
-- Networks and BIN prefixes for the launch catalog: 114 (card, network) pairs
-- across all 100 cards, and 99 BIN prefixes across 33 of them.
--
-- Keyed by (bank name, card name) rather than by id, because 0005 mints ids
-- with randomblob(16) -- they differ in every database, so there is nothing
-- stable to reference. Same join as 0006.
--
-- WHERE THIS DATA COMES FROM, AND HOW FAR TO TRUST IT
--
-- The NETWORK of each card is an editorial assignment from public product
-- information, in the same register as the fees in 0005 and the scores in
-- 0006: correct it over the admin API rather than by editing this file, which
-- is applied once and never re-run. Cards sold in more than one network
-- variant get a row per variant.
--
-- The BIN PREFIXES are real, taken from the open BIN/IIN dataset at
-- github.com/venelinkochev/bin-list-data, filtered to Indian consumer credit
-- and charge cards for these twelve issuers. None of them are invented.
--
-- But read what they actually assert. A 6-digit BIN identifies issuer +
-- network + product TIER (Visa Infinite, Mastercard World Elite), never an
-- individual product -- no public dataset resolves "which rewards card".
-- So a card here carries the prefixes of the issuing block its tier belongs
-- to. That is a SUPERSET of the prefixes the product itself uses:
--
--   * matching a BIN proves the card is that issuer, network and tier
--   * it does NOT prove it is that specific product
--   * two cards in one tier block therefore share prefixes, which is why
--     card_bins has no UNIQUE on bin_prefix
--
-- For a transaction check the direction of the error is the safe one: a
-- genuine holder is never turned away, and an imposter would still need a
-- card from the same issuer, network and tier.
--
-- A tier block wider than 8 prefixes is left out entirely -- Visa Platinum at
-- SBI is 25 prefixes shared by most of the portfolio, so asserting it of one
-- card says nothing. That is why only 33 of 100 cards have BIN rows. The
-- other 67 have no prefixes on file, which now means they are hidden from
-- discovery by the BIN gate in cards/queries.ts and cannot start a
-- verification at all.

-- The networks themselves, and the ISO/IEC 7812 prefix rules each allocates
-- under. Transcribed unchanged in meaning from the single CHECK an earlier
-- draft of 0009 carried; see the note there on why they are rows now.
--
-- Ids are minted here the same way 0005 mints bank and card ids: they differ in
-- every database, so everything below joins on `code` instead.
INSERT INTO networks (id, code, name)
WITH n(code, name) AS (
  VALUES
    ('visa'      , 'Visa'),
    ('mastercard', 'Mastercard'),
    ('amex'      , 'American Express'),
    ('diners'    , 'Diners Club'),
    ('rupay'     , 'RuPay'),
    -- The last three do not occur in an 'IN' catalog. They are seeded anyway
    -- because they cost a row each and an admin should not have to invent the
    -- ISO prefix rules for a network the standard already fixed.
    ('discover'  , 'Discover'),
    ('jcb'       , 'JCB'),
    ('unionpay'  , 'UnionPay')
)
SELECT 'network_' || lower(hex(randomblob(16))), code, name FROM n;

INSERT INTO network_bin_rules (network_id, kind, value)
WITH r(code, kind, value) AS (
  VALUES
    ('visa'      , 'glob' , '4*'),
    ('mastercard', 'glob' , '5[1-5]*'),
    ('mastercard', 'range', '2221-2720'),
    ('amex'      , 'glob' , '3[47]*'),
    ('diners'    , 'glob' , '3[68]*'),
    ('diners'    , 'glob' , '30[0-5]*'),
    ('rupay'     , 'glob' , '6[05]*'),
    ('rupay'     , 'glob' , '8[12]*'),
    ('rupay'     , 'glob' , '508*'),
    ('discover'  , 'glob' , '6011*'),
    ('discover'  , 'glob' , '64[4-9]*'),
    ('discover'  , 'glob' , '65*'),
    ('jcb'       , 'range', '3528-3589'),
    ('unionpay'  , 'glob' , '62*'),
    ('unionpay'  , 'glob' , '81*')
)
SELECT nw.id, r.kind, r.value
FROM r
JOIN networks nw ON nw.code = r.code;

INSERT INTO card_networks (card_id, network_id)
WITH nets(bank, card, network) AS (
  VALUES
    ('AU'              , 'Altura Plus'               , 'visa'),
    ('AU'              , 'LIT'                       , 'visa'),
    ('AU'              , 'Vetta'                     , 'visa'),
    ('AU'              , 'Zenith'                    , 'mastercard'),
    ('AU'              , 'Zenith+'                   , 'mastercard'),
    ('AU'              , 'ixigo'                     , 'rupay'),
    ('American Express', 'Centurion Charge Card'     , 'amex'),
    ('American Express', 'Gold Charge'               , 'amex'),
    ('American Express', 'Membership Rewards'        , 'amex'),
    ('American Express', 'Platinum Charge Card'      , 'amex'),
    ('American Express', 'Platinum Reserve'          , 'amex'),
    ('American Express', 'Platinum Travel'           , 'amex'),
    ('Axis'            , 'ACE'                       , 'visa'),
    ('Axis'            , 'Airtel'                    , 'visa'),
    ('Axis'            , 'Atlas'                     , 'visa'),
    ('Axis'            , 'Etihad Guest'              , 'visa'),
    ('Axis'            , 'Flipkart'                  , 'mastercard'),
    ('Axis'            , 'Horizon'                   , 'visa'),
    ('Axis'            , 'IndiGo'                    , 'visa'),
    ('Axis'            , 'IndiGo Premium'            , 'visa'),
    ('Axis'            , 'IndianOil'                 , 'visa'),
    ('Axis'            , 'Magnus'                    , 'mastercard'),
    ('Axis'            , 'Magnus for Burgundy'       , 'mastercard'),
    ('Axis'            , 'My Zone'                   , 'visa'),
    ('Axis'            , 'Primus'                    , 'mastercard'),
    ('Axis'            , 'Privilege'                 , 'visa'),
    ('Axis'            , 'Reserve'                   , 'visa'),
    ('Axis'            , 'Rewards'                   , 'visa'),
    ('Axis'            , 'Select'                    , 'visa'),
    ('Bank of Baroda'  , 'Eterna'                    , 'visa'),
    ('Bank of Baroda'  , 'Etihad Guest Premium'      , 'visa'),
    ('Bank of Baroda'  , 'Premier'                   , 'visa'),
    ('HDFC'            , 'Diners Club Black Metal'   , 'diners'),
    ('HDFC'            , 'Diners Club Miles'         , 'diners'),
    ('HDFC'            , 'Diners Club Privilege'     , 'diners'),
    ('HDFC'            , 'Infinia Metal'             , 'visa'),
    ('HDFC'            , 'Marriott Bonvoy'           , 'diners'),
    ('HDFC'            , 'Millennia'                 , 'visa'),
    ('HDFC'            , 'Millennia'                 , 'mastercard'),
    ('HDFC'            , 'PhonePe Ultimo'            , 'rupay'),
    ('HDFC'            , 'PhonePe Uno'               , 'rupay'),
    ('HDFC'            , 'Regalia'                   , 'visa'),
    ('HDFC'            , 'Regalia Gold'              , 'visa'),
    ('HDFC'            , 'Swiggy'                    , 'mastercard'),
    ('HDFC'            , 'Tata Neu Infinity'         , 'visa'),
    ('HDFC'            , 'Tata Neu Infinity'         , 'rupay'),
    ('HDFC'            , 'Tata Neu Plus'             , 'visa'),
    ('HDFC'            , 'Tata Neu Plus'             , 'rupay'),
    ('HSBC'            , 'Live+'                     , 'visa'),
    ('HSBC'            , 'Premier'                   , 'mastercard'),
    ('HSBC'            , 'Privé'                     , 'visa'),
    ('HSBC'            , 'Taj'                       , 'visa'),
    ('HSBC'            , 'Visa Platinum'             , 'visa'),
    ('ICICI'           , 'Adani One Platinum'        , 'visa'),
    ('ICICI'           , 'Adani One Signature'       , 'visa'),
    ('ICICI'           , 'Amazon Pay'                , 'visa'),
    ('ICICI'           , 'Coral'                     , 'visa'),
    ('ICICI'           , 'Coral'                     , 'mastercard'),
    ('ICICI'           , 'Emeralde Private Metal'    , 'visa'),
    ('ICICI'           , 'Emeralde Private Metal'    , 'mastercard'),
    ('ICICI'           , 'HPCL Coral'                , 'visa'),
    ('ICICI'           , 'HPCL Super Saver'          , 'visa'),
    ('ICICI'           , 'MakeMyTrip'                , 'mastercard'),
    ('ICICI'           , 'Manchester United Platinum', 'visa'),
    ('ICICI'           , 'Rubyx'                     , 'visa'),
    ('ICICI'           , 'Rubyx'                     , 'amex'),
    ('ICICI'           , 'Sapphiro'                  , 'visa'),
    ('ICICI'           , 'Sapphiro'                  , 'amex'),
    ('ICICI'           , 'Times Black'               , 'visa'),
    ('IDFC FIRST'      , 'Classic'                   , 'visa'),
    ('IDFC FIRST'      , 'Mayura'                    , 'visa'),
    ('IDFC FIRST'      , 'Power+'                    , 'visa'),
    ('IDFC FIRST'      , 'Select'                    , 'visa'),
    ('IDFC FIRST'      , 'WOW!'                      , 'visa'),
    ('IDFC FIRST'      , 'Wealth'                    , 'visa'),
    ('IndusInd'        , 'Crest'                     , 'mastercard'),
    ('IndusInd'        , 'EazyDiner Signature'       , 'visa'),
    ('IndusInd'        , 'Indulge'                   , 'visa'),
    ('IndusInd'        , 'Legend'                    , 'visa'),
    ('IndusInd'        , 'Pinnacle'                  , 'visa'),
    ('IndusInd'        , 'Pinnacle'                  , 'mastercard'),
    ('IndusInd'        , 'Pioneer Heritage'          , 'visa'),
    ('IndusInd'        , 'Pioneer Heritage'          , 'mastercard'),
    ('IndusInd'        , 'Pioneer Legacy'            , 'mastercard'),
    ('IndusInd'        , 'Solitaire'                 , 'visa'),
    ('IndusInd'        , 'Tiger'                     , 'rupay'),
    ('Kotak'           , 'IndianOil'                 , 'visa'),
    ('Kotak'           , 'White Reserve'             , 'visa'),
    ('Kotak'           , 'Zen Signature'             , 'visa'),
    ('RBL'             , 'IndianOil XTRA'            , 'mastercard'),
    ('RBL'             , 'Platinum Maxima'           , 'mastercard'),
    ('RBL'             , 'ShopRite'                  , 'mastercard'),
    ('RBL'             , 'World Safari'              , 'mastercard'),
    ('SBI'             , 'AURUM'                     , 'visa'),
    ('SBI'             , 'Air India Platinum'        , 'visa'),
    ('SBI'             , 'Air India Signature'       , 'visa'),
    ('SBI'             , 'BPCL'                      , 'visa'),
    ('SBI'             , 'BPCL Octane'               , 'visa'),
    ('SBI'             , 'Cashback'                  , 'visa'),
    ('SBI'             , 'Cashback'                  , 'rupay'),
    ('SBI'             , 'Elite'                     , 'visa'),
    ('SBI'             , 'Elite'                     , 'mastercard'),
    ('SBI'             , 'Elite'                     , 'amex'),
    ('SBI'             , 'IRCTC'                     , 'rupay'),
    ('SBI'             , 'IRCTC Premier'             , 'rupay'),
    ('SBI'             , 'Miles'                     , 'visa'),
    ('SBI'             , 'Miles ELITE'               , 'visa'),
    ('SBI'             , 'Miles PRIME'               , 'visa'),
    ('SBI'             , 'SimplyCLICK'               , 'visa'),
    ('SBI'             , 'SimplySAVE'                , 'visa'),
    ('SBI'             , 'Tata Neu Infinity'         , 'visa'),
    ('SBI'             , 'Tata Neu Infinity'         , 'rupay'),
    ('SBI'             , 'Tata Neu Plus'             , 'visa'),
    ('SBI'             , 'Tata Neu Plus'             , 'rupay')
)
SELECT c.id, nw.id
FROM nets n
JOIN networks nw ON nw.code = n.network
JOIN banks b ON b.name = n.bank
JOIN cards c ON c.bank_id = b.id AND c.name = n.card;

-- Every prefix below satisfies its network's rule in network_bin_rules, and
-- that was verified by query when this file was written -- not by a
-- constraint. There is no backstop here: a CHECK cannot subquery
-- network_bin_rules, so a hand-authored seed row is checked by nobody. If you
-- add prefixes in a later migration, verify them yourself:
--
--   SELECT cb.bin_prefix, nw.code FROM card_bins cb
--   JOIN networks nw ON nw.id = cb.network_id
--   WHERE NOT EXISTS (SELECT 1 FROM network_bin_rules r
--                     WHERE r.network_id = cb.network_id
--                       AND (cb.bin_prefix GLOB r.value
--                            OR (r.kind = 'range' AND ...)));
INSERT INTO card_bins (card_id, network_id, bin_prefix)
WITH bins(bank, card, network, bin_prefix) AS (
  VALUES
    ('AU'            , 'Altura Plus'               , 'visa'      , '466505'),
    ('AU'            , 'Altura Plus'               , 'visa'      , '466572'),
    ('AU'            , 'LIT'                       , 'visa'      , '465523'),
    ('AU'            , 'Vetta'                     , 'visa'      , '465523'),
    ('Axis'          , 'Primus'                    , 'mastercard', '529495'),
    ('Axis'          , 'Rewards'                   , 'visa'      , '407186'),
    ('Axis'          , 'Rewards'                   , 'visa'      , '407200'),
    ('Axis'          , 'Rewards'                   , 'visa'      , '438106'),
    ('Axis'          , 'Rewards'                   , 'visa'      , '440006'),
    ('Bank of Baroda', 'Eterna'                    , 'visa'      , '460139'),
    ('HDFC'          , 'Infinia Metal'             , 'visa'      , '417410'),
    ('HDFC'          , 'Infinia Metal'             , 'visa'      , '436152'),
    ('HDFC'          , 'Infinia Metal'             , 'visa'      , '437546'),
    ('HSBC'          , 'Live+'                     , 'visa'      , '461716'),
    ('HSBC'          , 'Live+'                     , 'visa'      , '461721'),
    ('HSBC'          , 'Live+'                     , 'visa'      , '486269'),
    ('HSBC'          , 'Premier'                   , 'mastercard', '527393'),
    ('HSBC'          , 'Privé'                     , 'visa'      , '438459'),
    ('HSBC'          , 'Taj'                       , 'visa'      , '431104'),
    ('HSBC'          , 'Taj'                       , 'visa'      , '461709'),
    ('HSBC'          , 'Visa Platinum'             , 'visa'      , '461716'),
    ('HSBC'          , 'Visa Platinum'             , 'visa'      , '461721'),
    ('HSBC'          , 'Visa Platinum'             , 'visa'      , '486269'),
    ('ICICI'         , 'Adani One Platinum'        , 'visa'      , '403562'),
    ('ICICI'         , 'Adani One Platinum'        , 'visa'      , '407918'),
    ('ICICI'         , 'Adani One Platinum'        , 'visa'      , '437551'),
    ('ICICI'         , 'Adani One Platinum'        , 'visa'      , '447380'),
    ('ICICI'         , 'Adani One Platinum'        , 'visa'      , '448967'),
    ('ICICI'         , 'Adani One Platinum'        , 'visa'      , '462986'),
    ('ICICI'         , 'Adani One Platinum'        , 'visa'      , '474846'),
    ('ICICI'         , 'Emeralde Private Metal'    , 'visa'      , '461133'),
    ('ICICI'         , 'Emeralde Private Metal'    , 'visa'      , '482040'),
    ('ICICI'         , 'Emeralde Private Metal'    , 'mastercard', '547309'),
    ('ICICI'         , 'Manchester United Platinum', 'visa'      , '403562'),
    ('ICICI'         , 'Manchester United Platinum', 'visa'      , '407918'),
    ('ICICI'         , 'Manchester United Platinum', 'visa'      , '437551'),
    ('ICICI'         , 'Manchester United Platinum', 'visa'      , '447380'),
    ('ICICI'         , 'Manchester United Platinum', 'visa'      , '448967'),
    ('ICICI'         , 'Manchester United Platinum', 'visa'      , '462986'),
    ('ICICI'         , 'Manchester United Platinum', 'visa'      , '474846'),
    ('ICICI'         , 'Times Black'               , 'visa'      , '461133'),
    ('ICICI'         , 'Times Black'               , 'visa'      , '482040'),
    ('IDFC FIRST'    , 'Mayura'                    , 'visa'      , '440523'),
    ('IDFC FIRST'    , 'Select'                    , 'visa'      , '401063'),
    ('IDFC FIRST'    , 'Select'                    , 'visa'      , '428102'),
    ('IDFC FIRST'    , 'Wealth'                    , 'visa'      , '440523'),
    ('IndusInd'      , 'Crest'                     , 'mastercard', '529243'),
    ('IndusInd'      , 'Crest'                     , 'mastercard', '529370'),
    ('IndusInd'      , 'EazyDiner Signature'       , 'visa'      , '414752'),
    ('IndusInd'      , 'EazyDiner Signature'       , 'visa'      , '414772'),
    ('IndusInd'      , 'EazyDiner Signature'       , 'visa'      , '470050'),
    ('IndusInd'      , 'EazyDiner Signature'       , 'visa'      , '491519'),
    ('IndusInd'      , 'Indulge'                   , 'visa'      , '407484'),
    ('IndusInd'      , 'Indulge'                   , 'visa'      , '427124'),
    ('IndusInd'      , 'Indulge'                   , 'visa'      , '441283'),
    ('IndusInd'      , 'Indulge'                   , 'visa'      , '498726'),
    ('IndusInd'      , 'Legend'                    , 'visa'      , '414752'),
    ('IndusInd'      , 'Legend'                    , 'visa'      , '414772'),
    ('IndusInd'      , 'Legend'                    , 'visa'      , '470050'),
    ('IndusInd'      , 'Legend'                    , 'visa'      , '491519'),
    ('IndusInd'      , 'Pinnacle'                  , 'visa'      , '407484'),
    ('IndusInd'      , 'Pinnacle'                  , 'visa'      , '427124'),
    ('IndusInd'      , 'Pinnacle'                  , 'visa'      , '441283'),
    ('IndusInd'      , 'Pinnacle'                  , 'visa'      , '498726'),
    ('IndusInd'      , 'Pinnacle'                  , 'mastercard', '529243'),
    ('IndusInd'      , 'Pinnacle'                  , 'mastercard', '529370'),
    ('IndusInd'      , 'Pioneer Heritage'          , 'visa'      , '407484'),
    ('IndusInd'      , 'Pioneer Heritage'          , 'visa'      , '427124'),
    ('IndusInd'      , 'Pioneer Heritage'          , 'visa'      , '441283'),
    ('IndusInd'      , 'Pioneer Heritage'          , 'visa'      , '498726'),
    ('IndusInd'      , 'Pioneer Heritage'          , 'mastercard', '529243'),
    ('IndusInd'      , 'Pioneer Heritage'          , 'mastercard', '529370'),
    ('IndusInd'      , 'Pioneer Legacy'            , 'mastercard', '529243'),
    ('IndusInd'      , 'Pioneer Legacy'            , 'mastercard', '529370'),
    ('IndusInd'      , 'Solitaire'                 , 'visa'      , '414752'),
    ('IndusInd'      , 'Solitaire'                 , 'visa'      , '414772'),
    ('IndusInd'      , 'Solitaire'                 , 'visa'      , '470050'),
    ('IndusInd'      , 'Solitaire'                 , 'visa'      , '491519'),
    ('Kotak'         , 'White Reserve'             , 'visa'      , '434668'),
    ('Kotak'         , 'Zen Signature'             , 'visa'      , '414767'),
    ('Kotak'         , 'Zen Signature'             , 'visa'      , '442126'),
    ('Kotak'         , 'Zen Signature'             , 'visa'      , '442127'),
    ('Kotak'         , 'Zen Signature'             , 'visa'      , '442128'),
    ('Kotak'         , 'Zen Signature'             , 'visa'      , '463663'),
    ('RBL'           , 'Platinum Maxima'           , 'mastercard', '517456'),
    ('RBL'           , 'Platinum Maxima'           , 'mastercard', '542505'),
    ('RBL'           , 'World Safari'              , 'mastercard', '522012'),
    ('RBL'           , 'World Safari'              , 'mastercard', '523650'),
    ('RBL'           , 'World Safari'              , 'mastercard', '524373'),
    ('RBL'           , 'World Safari'              , 'mastercard', '525611'),
    ('RBL'           , 'World Safari'              , 'mastercard', '536907'),
    ('SBI'           , 'AURUM'                     , 'visa'      , '478748'),
    ('SBI'           , 'AURUM'                     , 'visa'      , '480251'),
    ('SBI'           , 'Elite'                     , 'amex'      , '340020'),
    ('SBI'           , 'Elite'                     , 'amex'      , '340475'),
    ('SBI'           , 'Elite'                     , 'amex'      , '340507'),
    ('SBI'           , 'Elite'                     , 'amex'      , '370308'),
    ('SBI'           , 'Elite'                     , 'amex'      , '377150'),
    ('SBI'           , 'Elite'                     , 'amex'      , '377154')
)
SELECT c.id, nw.id, x.bin_prefix
FROM bins x
JOIN networks nw ON nw.code = x.network
JOIN banks b ON b.name = x.bank
JOIN cards c ON c.bank_id = b.id AND c.name = x.card;
