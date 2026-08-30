-- Migration number: 0006 	 2026-08-29T00:00:00.000Z
-- Opening scores for the seeded catalog: every card against every criterion.
--
-- These are EDITORIAL JUDGEMENTS, not published figures. Indian card benefits
-- move constantly (reward devaluations, milestone reworks, lounge-access rule
-- changes), so treat this as a starting position to revise -- over
-- PUT /v1/cards/:id/scores, not by editing this file, which is applied once
-- and never re-run.
--
-- The columns below are the rubric in weight order, so a row reads across as
-- one card's whole scorecard. The CASE unpivots them into card_scores.

INSERT INTO card_scores (card_id, criterion_id, score)
WITH marks(bank, card, rewards, travel, lifestyle, prestige, milestone, forex, fees) AS (
  VALUES
    ('HDFC'            , 'Infinia Metal'             , 10,  9,  9,  8,  6,  7, 10),
    ('HDFC'            , 'Diners Club Black Metal'   , 10,  9, 10,  8,  7,  7, 10),
    ('ICICI'           , 'Emeralde Private Metal'    ,  8,  9,  9,  8,  8,  7,  8),
    ('Axis'            , 'Magnus for Burgundy'       ,  7,  8,  7,  7,  6,  7,  6),
    ('American Express', 'Platinum Charge Card'      ,  5, 10, 10, 10,  9,  5,  7),
    ('Axis'            , 'Reserve'                   ,  8,  9,  8,  8,  7,  8,  6),
    ('Kotak'           , 'White Reserve'             ,  6,  7,  7,  6,  6,  6,  5),
    ('SBI'             , 'AURUM'                     ,  4,  7,  7,  6,  5,  5,  4),
    ('IndusInd'        , 'Pinnacle'                  ,  6,  7,  6,  6,  5,  6,  5),
    ('Axis'            , 'Atlas'                     ,  7,  8,  5,  5,  7,  6,  7),
    ('Axis'            , 'Magnus'                    ,  6,  7,  6,  5,  6,  7,  5),
    ('IDFC FIRST'      , 'Mayura'                    ,  7,  7,  6,  5,  6,  8,  7),
    ('HSBC'            , 'Taj'                       ,  6,  6,  9,  7,  7,  6,  6),
    ('ICICI'           , 'Times Black'               ,  7,  8,  8,  7,  7,  8,  6),
    ('IndusInd'        , 'Pioneer Heritage'          ,  7,  8,  8,  8,  6,  7,  5),
    ('IndusInd'        , 'Pioneer Legacy'            ,  6,  7,  7,  7,  5,  6,  6),
    ('IndusInd'        , 'Solitaire'                 ,  5,  6,  6,  6,  5,  6,  4),
    ('IndusInd'        , 'Indulge'                   ,  4,  6,  7,  8,  4,  5,  3),
    ('IndusInd'        , 'Crest'                     ,  5,  6,  6,  7,  4,  5,  3),
    ('HSBC'            , 'Privé'                     ,  6,  9,  9, 10,  6,  7,  3),
    ('American Express', 'Centurion Charge Card'     ,  5, 10, 10, 10,  7,  5,  3),
    ('Axis'            , 'Primus'                    ,  7,  9,  9,  9,  6,  8,  3),
    ('American Express', 'Platinum Reserve'          ,  5,  7,  7,  7,  7,  5,  6),
    ('American Express', 'Platinum Travel'           ,  6,  7,  5,  6,  9,  5,  8),
    ('HDFC'            , 'Marriott Bonvoy'           ,  7,  7,  7,  5,  7,  6,  8),
    ('HDFC'            , 'Regalia Gold'              ,  6,  6,  5,  4,  7,  7,  7),
    ('HDFC'            , 'Regalia'                   ,  5,  5,  4,  4,  5,  7,  5),
    ('HDFC'            , 'Diners Club Privilege'     ,  5,  5,  5,  4,  6,  6,  6),
    ('HDFC'            , 'Diners Club Miles'         ,  5,  5,  4,  3,  5,  6,  5),
    ('HDFC'            , 'Millennia'                 ,  6,  3,  3,  2,  4,  3,  7),
    ('HDFC'            , 'Swiggy'                    ,  7,  1,  4,  2,  3,  2,  8),
    ('HDFC'            , 'Tata Neu Infinity'         ,  7,  3,  4,  3,  4,  5,  7),
    ('HDFC'            , 'Tata Neu Plus'             ,  5,  2,  3,  2,  3,  3,  6),
    ('HDFC'            , 'PhonePe Ultimo'            ,  6,  4,  4,  3,  4,  4,  5),
    ('HDFC'            , 'PhonePe Uno'               ,  5,  2,  3,  2,  3,  3,  6),
    ('SBI'             , 'Elite'                     ,  4,  6,  5,  4,  6,  5,  4),
    ('SBI'             , 'Air India Signature'       ,  5,  6,  3,  4,  6,  4,  4),
    ('SBI'             , 'Air India Platinum'        ,  4,  4,  2,  3,  5,  3,  4),
    ('SBI'             , 'BPCL Octane'               ,  6,  3,  3,  3,  4,  3,  7),
    ('SBI'             , 'BPCL'                      ,  5,  2,  2,  2,  3,  2,  6),
    ('SBI'             , 'Cashback'                  ,  8,  1,  2,  3,  2,  3,  9),
    ('SBI'             , 'SimplyCLICK'               ,  5,  1,  2,  2,  4,  2,  6),
    ('SBI'             , 'SimplySAVE'                ,  4,  1,  3,  2,  3,  2,  5),
    ('SBI'             , 'IRCTC'                     ,  4,  3,  1,  2,  2,  2,  5),
    ('SBI'             , 'IRCTC Premier'             ,  4,  4,  2,  2,  3,  2,  4),
    ('SBI'             , 'Miles ELITE'               ,  6,  7,  4,  5,  6,  5,  5),
    ('SBI'             , 'Miles'                     ,  5,  5,  3,  3,  5,  4,  5),
    ('SBI'             , 'Miles PRIME'               ,  5,  6,  3,  4,  5,  4,  5),
    ('SBI'             , 'Tata Neu Infinity'         ,  7,  3,  4,  3,  4,  5,  7),
    ('SBI'             , 'Tata Neu Plus'             ,  5,  2,  3,  2,  3,  3,  6),
    ('ICICI'           , 'Sapphiro'                  ,  5,  6,  6,  5,  5,  5,  5),
    ('ICICI'           , 'Rubyx'                     ,  4,  5,  5,  4,  4,  4,  4),
    ('ICICI'           , 'Coral'                     ,  3,  3,  3,  2,  3,  3,  5),
    ('ICICI'           , 'Amazon Pay'                ,  8,  1,  3,  3,  2,  2, 10),
    ('ICICI'           , 'Adani One Signature'       ,  5,  4,  3,  3,  4,  3,  5),
    ('ICICI'           , 'Adani One Platinum'        ,  4,  3,  2,  2,  3,  2,  4),
    ('ICICI'           , 'MakeMyTrip'                ,  5,  5,  3,  3,  5,  3,  6),
    ('ICICI'           , 'HPCL Super Saver'          ,  5,  2,  2,  2,  3,  2,  6),
    ('ICICI'           , 'HPCL Coral'                ,  4,  2,  2,  2,  3,  2,  5),
    ('ICICI'           , 'Manchester United Platinum',  3,  2,  3,  3,  3,  2,  4),
    ('Axis'            , 'Horizon'                   ,  6,  7,  4,  4,  6,  6,  6),
    ('Axis'            , 'Select'                    ,  5,  5,  5,  4,  5,  5,  5),
    ('Axis'            , 'Privilege'                 ,  4,  4,  4,  3,  4,  4,  4),
    ('Axis'            , 'Airtel'                    ,  7,  1,  3,  2,  3,  2,  8),
    ('Axis'            , 'Flipkart'                  ,  7,  2,  3,  3,  3,  3,  8),
    ('Axis'            , 'ACE'                       ,  7,  2,  3,  2,  3,  2,  8),
    ('Axis'            , 'IndianOil'                 ,  5,  2,  2,  2,  3,  2,  6),
    ('Axis'            , 'IndiGo Premium'            ,  5,  6,  3,  4,  6,  4,  5),
    ('Axis'            , 'IndiGo'                    ,  4,  5,  2,  3,  5,  3,  5),
    ('Axis'            , 'Etihad Guest'              ,  5,  6,  3,  4,  5,  5,  5),
    ('Axis'            , 'Rewards'                   ,  5,  3,  4,  3,  4,  3,  5),
    ('Axis'            , 'My Zone'                   ,  4,  2,  4,  2,  3,  2,  6),
    ('IDFC FIRST'      , 'Wealth'                    ,  6,  6,  5,  4,  5,  8, 10),
    ('IDFC FIRST'      , 'Select'                    ,  5,  5,  4,  3,  4,  8,  9),
    ('IDFC FIRST'      , 'WOW!'                      ,  4,  4,  2,  2,  2, 10,  9),
    ('IDFC FIRST'      , 'Classic'                   ,  4,  3,  2,  2,  3,  7,  8),
    ('IDFC FIRST'      , 'Power+'                    ,  5,  2,  2,  2,  3,  5,  6),
    ('AU'              , 'Zenith+'                   ,  6,  7,  6,  5,  6,  6,  6),
    ('AU'              , 'Zenith'                    ,  5,  6,  5,  5,  5,  5,  4),
    ('AU'              , 'Vetta'                     ,  5,  5,  4,  4,  5,  4,  5),
    ('AU'              , 'ixigo'                     ,  5,  5,  2,  2,  3,  9,  9),
    ('AU'              , 'LIT'                       ,  5,  3,  3,  2,  3,  4,  8),
    ('AU'              , 'Altura Plus'               ,  4,  2,  2,  2,  3,  3,  5),
    ('HSBC'            , 'Live+'                     ,  7,  3,  5,  3,  4,  4,  8),
    ('HSBC'            , 'Premier'                   ,  6,  8,  8,  8,  6,  8,  5),
    ('HSBC'            , 'Visa Platinum'             ,  4,  3,  3,  2,  3,  3,  8),
    ('IndusInd'        , 'Legend'                    ,  5,  5,  5,  4,  4,  5,  8),
    ('IndusInd'        , 'Tiger'                     ,  4,  4,  4,  3,  3,  4,  8),
    ('IndusInd'        , 'EazyDiner Signature'       ,  5,  3,  7,  4,  4,  4,  5),
    ('RBL'             , 'World Safari'              ,  5,  7,  3,  4,  5, 10,  6),
    ('RBL'             , 'IndianOil XTRA'            ,  5,  2,  2,  2,  3,  2,  5),
    ('RBL'             , 'ShopRite'                  ,  4,  1,  3,  2,  3,  2,  5),
    ('RBL'             , 'Platinum Maxima'           ,  4,  3,  3,  2,  4,  3,  4),
    ('Bank of Baroda'  , 'Eterna'                    ,  6,  5,  5,  3,  4,  5,  6),
    ('Bank of Baroda'  , 'Etihad Guest Premium'      ,  5,  6,  3,  4,  5,  5,  4),
    ('Bank of Baroda'  , 'Premier'                   ,  4,  3,  3,  2,  3,  3,  4),
    ('Kotak'           , 'Zen Signature'             ,  5,  4,  4,  3,  4,  4,  5),
    ('Kotak'           , 'IndianOil'                 ,  4,  2,  2,  2,  3,  2,  5),
    ('American Express', 'Membership Rewards'        ,  6,  4,  4,  5,  8,  4,  6),
    ('American Express', 'Gold Charge'               ,  6,  4,  4,  5,  8,  4,  6)
)
SELECT c.id, sc.id,
       CASE sc.name
         WHEN 'Rewards / Returns'              THEN m.rewards
         WHEN 'Travel Benefits'                THEN m.travel
         WHEN 'Lifestyle Benefits'             THEN m.lifestyle
         WHEN 'Exclusivity / Prestige'         THEN m.prestige
         WHEN 'Milestone / Welcome Benefits'   THEN m.milestone
         WHEN 'Forex / International'          THEN m.forex
         WHEN 'Fees vs Value'                  THEN m.fees
       END
FROM marks m
JOIN banks b            ON b.name = m.bank
JOIN cards c            ON c.bank_id = b.id AND c.name = m.card
-- Restricted to the seeded rubric: any criterion added later has no column
-- here, and would otherwise unpivot to NULL and fail the NOT NULL constraint.
JOIN scoring_criteria sc ON sc.name IN ('Rewards / Returns', 'Travel Benefits', 'Lifestyle Benefits', 'Exclusivity / Prestige', 'Milestone / Welcome Benefits', 'Forex / International', 'Fees vs Value');
