# Card and BIN requests

**Date:** 2026-09-05
**Status:** built

## The problem

The catalog will never carry every card in India, and two thirds of the cards it
does carry have no BIN prefixes on file — 67 of the 100 seeded. Both were dead
ends with no way out:

- a card that is not in the catalog is not searchable, so there is nothing to
  find and nothing to report;
- a card that is in the catalog but has no prefixes was filtered out of the
  picker entirely, and `POST /v1/verifications` refuses it outright.

Either way the person gave up and we never learned which card was missing.

## What was built

`card_requests` (migration 0016), a `cardRequests` module at
`/v1/card-requests`, a `#/requests` screen, and a fourth section in the admin
console at `#/admin/requests`. A signed-in person asks for a card
(`kind = 'card'`) or for prefixes on one (`kind = 'bin'`); an admin edits the
submission into shape, does the real catalog write through the existing
endpoints, and then records the approval.

The picker also stopped hiding unselectable cards, which is the larger half of
the value: the backlog is a known 67 cards, and the people who can close it are
the ones holding those cards.

## The decisions worth writing down

Four things are not obvious from the code, and one of them we got wrong first.

### One table with a `kind` column, not two tables

Eleven of about sixteen columns are shared — owner, status machine, review
trio, timestamps — and the two kinds differ in five. Two tables would fork the
validator, the routes, the types, both list reads and the whole frontend to save
those five. `network_bin_rules` in migration 0009 already made this trade, with
asymmetric per-kind CHECKs; 0016 carries the asymmetry the same way.

### One `card_id`, meaning "the catalog card this request concerns"

On a `bin` request it is the target and it is set at insert. On a `card` request
it is the result and stays NULL until approval fills it in. A separate
`resolved_card_id` would hold the same value as `card_id` on every `bin` row — a
second copy of one fact, and a place for the two to disagree.

### Approval is gated on existence and active, never on selectability

**This is the one an earlier draft got wrong**, so it is worth stating what the
wrong version was. It required the resolved card to have at least one BIN
prefix, reasoning that a card with none is invisible in the picker, so
"approved" would be a lie.

Two things break under that rule:

1. **A corrected prefix becomes unapprovable.** Somebody submits `412345`; the
   admin knows the real prefix is `414767` and records that. A gate keyed on the
   requested value refuses to approve a request the admin fully honoured, leaving
   only two exits — fabricate the guess into `card_bins`, which is the table the
   ₹1 verification matches against, or wedge the queue for ever.
2. **It rewards inventing data.** A card with no prefixes is a documented,
   supported state; `AdminCardPage` renders a "No BINs" pill, not an error. An
   admin who adds the requested card without prefix data to hand *has* honoured
   the request. Blocking them there pressures them to make a prefix up.

So the hard gate is: the card exists, and is active. (`cards.getCard` resolves
inactive cards on purpose, so that second half has to be asked explicitly.)
`selectable` is returned in the approve response and reported in words — *"added
to the catalog, it will appear once we have its BIN prefixes"* — on both the
console and the requester's own list. **Honesty here is a copy problem, not a
constraint problem.** Two tests pin this and must not be softened:

- approving a card with zero BINs returns 200 with `selectable: false`;
- approving a `bin` request after the admin recorded a *different* prefix
  returns 200.

### No `country` on a request

`cards.country` is NOT NULL and `validateCardInput` requires it, but a person
filling in a form has no idea what to answer. The product is India-only —
Razorpay, ₹1, rupee fees — so the admin's `POST /v1/cards` supplies it and the
form never asks.

## Consequences we had to handle

**A wallet can now hold a card nothing can ever verify.** `primaryCta` only
returned "Reveal" when `verifiedCount === chosenCount`, so such a wallet would
have sat on "Verify cards" for ever. It and `verifyLine` now take a
`blockedCount` and exclude unverifiable cards from the target.

**Adding a prefix is read–merge–replace, always.** `PATCH /v1/cards/:id
{ networks }` replaces, and `replaceNetworks` begins with an unconditional
`DELETE FROM card_bins WHERE card_id = ?`. A naive approval that PATCHed one
prefix onto a dual-network card would wipe the rest, return 200, and break
`POST /v1/verifications` for every existing holder — a user-facing outage
triggered by an admin approving a request. `bin` requests therefore link out to
the card editor, which already does the right thing, and the one convenience
path is `mergeCardBins` in `data/adminApi.ts`.

**`GET /v1/networks/options` is new and public.** The form has to ask which
network a card runs on, and the alternative was hardcoding eight codes in the
bundle. It publishes each live network's code and display name and nothing else
— no id, no `binRules`. The networks module's own docstring predicted this
change.

**This feature asks people to type digits off their credit card**, inside an app
that also runs a card-verification flow — an interaction indistinguishable from
phishing training. Mitigated in three places: the field is labelled "the first 6
digits only — never your full card number", `maxLength` is 8 so a PAN cannot be
typed in, and the validator has a specific message for over-long digit strings
that never echoes the value back.

## Deliberately not built

- **No notification.** Status is pull-only, on the `#/requests` screen. There is
  no email infrastructure beyond Clerk's.
- **No public counts.** Ten people wanting the same card is the most useful
  thing in the queue, but a public "23 people want this" endpoint is a free
  product-roadmap scrape that invites brigading. It stays behind `adminAuth`.
- **No `GET /v1/card-requests/:id`.** Both lists carry everything either audience
  needs, and its absence removes any route-ordering question against `/review`.
- **No rate limiting**, because the codebase has none anywhere. Sign-in is the
  real gate; the two partial unique indexes, the cap of ten open requests, and
  `DELETE` as a release valve are hygiene on top.

## Known loose end

`idx_banks_name` is a plain UNIQUE under SQLite's default BINARY collation, so
`HDFC` and `hdfc` can already both exist as banks — and this feature hands
people a keyboard pointed straight at it. A typed issuer is matched
case-insensitively and adopted on an exact hit, which stops it getting worse.
Fixing the index is a separate migration and a separate decision.
