-- Migration number: 0017 	 2026-09-05T00:00:00.000Z
-- Four BIN prefixes published on BookMyShow's card-offer pages.
--
-- WHY FOUR, OUT OF TWO HUNDRED AND FORTY-FIVE.
-- The source is a scrape of BookMyShow's offer terms, which is the best public
-- list of Indian card BINs there is. It is also shaped wrongly for this table:
-- it maps a prefix to a BANK AND AN OFFER, and `card_bins` maps a prefix to a
-- PRODUCT. Of the 245 distinct prefixes in it:
--
--   135  belong to an offer naming a group of cards ("Legend / Nexxt / Duo /
--        Signature / Iconia / Intermiles", "Credit Card Offer"), or a product
--        this catalog does not carry
--   102  belong to a bank this catalog does not carry -- Bandhan, Bank of
--        Maharashtra, Canara, DBS, Federal, J&K, PNB, Reliance SBI, SBM,
--        Standard Chartered, YES, ZET
--     3  are claimed by more than one offer, so nothing decides which card owns
--        them: 457036 and 653023 across AU Zenith and Zenith+, and 438459
--        across HSBC Privé and Taj
--     1  is already on the card it belongs to
--     4  name exactly one product we carry, and are below
--
-- THE ONES THAT WERE LEFT OUT ARE NOT LOST, THEY ARE UNATTRIBUTED. A prefix
-- from a six-card offer has six candidate owners, and guessing is worse than
-- waiting: this is the table `POST /v1/verifications` narrows Checkout with and
-- the one a real card is matched against, so a prefix under the wrong product
-- refuses somebody's genuine card or accepts somebody else's. The remaining 241
-- want either a bank-level home -- which this schema has no table for -- or the
-- banks and products they name.
--
-- TWO NETWORK ROWS COME FIRST, and they are a change in what those cards will
-- accept, not bookkeeping. card_bins carries a composite foreign key onto
-- card_networks, so a prefix cannot claim a network its card is not recorded on
-- -- and BookMyShow lists AURUM on Mastercard as well as Visa, and IndianOil on
-- RuPay as well as Visa. Adding those rows means a Mastercard AURUM and a RuPay
-- IndianOil can now be proved, which is the point; it also means `judge()` will
-- accept those networks for those cards, which is the consequence.
--
-- Cards are looked up by name, never by id: ids are minted per database, so a
-- hardcoded one would be wrong everywhere but the machine it was written on.
--
-- THE `NOT EXISTS` GUARDS DEPART FROM HOUSE STYLE, which is that migrations are
-- written plainly and run exactly once. 0010 could insert bare because it seeded
-- empty tables on a database nobody had touched. This one lands on tables an
-- admin can already edit through /v1/cards -- so somebody adding AURUM's
-- Mastercard by hand before this ships would collide with the primary key,
-- fail the migration, and take the deploy down with it. The guard costs a
-- subquery and buys a deploy that cannot be broken from the admin panel.

INSERT INTO card_networks (card_id, network_id)
WITH nets(bank, card, network) AS (
  VALUES
    ('SBI' , 'AURUM'     , 'mastercard'),
    ('Axis', 'IndianOil' , 'rupay')
)
SELECT c.id, n.id
FROM nets
JOIN banks b    ON b.name = nets.bank
JOIN cards c    ON c.bank_id = b.id AND c.name = nets.card
JOIN networks n ON n.code = nets.network
-- Idempotent against a database that already has the pairing, which the
-- catalog's own seeds may grow later.
WHERE NOT EXISTS (
  SELECT 1 FROM card_networks existing
  WHERE existing.card_id = c.id AND existing.network_id = n.id
);

INSERT INTO card_bins (card_id, network_id, bin_prefix)
WITH bins(bank, card, network, bin_prefix) AS (
  VALUES
    -- https://in.bookmyshow.com/offers/aurum-credit-card-offer/SBISPR0420
    ('SBI' , 'AURUM'    , 'mastercard', '530917'),
    -- https://in.bookmyshow.com/offers/axis-bank-neo-and-indian-oil-credit-card-offer/AXSIN0324
    ('Axis', 'IndianOil', 'visa'      , '451456'),
    ('Axis', 'IndianOil', 'rupay'     , '652922'),
    -- https://in.bookmyshow.com/offers/hsbc-premier-credit-card-offer/HSBCP0923
    ('HSBC', 'Premier'  , 'mastercard', '512042')
)
SELECT c.id, n.id, bins.bin_prefix
FROM bins
JOIN banks b    ON b.name = bins.bank
JOIN cards c    ON c.bank_id = b.id AND c.name = bins.card
JOIN networks n ON n.code = bins.network
WHERE NOT EXISTS (
  SELECT 1 FROM card_bins existing
  WHERE existing.card_id = c.id AND existing.bin_prefix = bins.bin_prefix
);
