# ratemycards API

Cloudflare Workers API for Rate My Cards. Hono for routing, D1 (SQLite) for
storage, no ORM.

Requires **Node >= 22** — Wrangler 4.87+ exits on anything older. `.nvmrc` at the
repo root pins it; run `nvm use`.

## Modules

| Module | Path | Owns |
| ------ | ---- | ----- |
| banks   | `src/modules/banks/` | `banks` — card issuers |
| cards   | `src/modules/cards/` | `cards`, `card_networks`, `card_bins` — the catalog of supported cards |
| networks | `src/modules/networks/` | `networks`, `network_bin_rules` — the payment networks a card can run on, and the BIN prefix rules each allocates under |
| scoring | `src/modules/scoring/` | `scoring_criteria`, `card_scores` — the rubric |
| wallet  | `src/modules/wallet/` | `wallet_cards` — which cards a signed-in person holds |
| users   | `src/modules/users/` | `users` — who is behind a session |
| verification | `src/modules/verification/` | `card_verifications` — the ₹1 proof that a card is really held |
| cardRequests | `src/modules/cardRequests/` | `card_requests`, `card_request_bins` — cards and BIN prefixes people have asked for |
| profiles | `src/modules/profiles/` | owns no tables — composes `users` and `wallet` into the one public read |

A bank has many cards (`cards.bank_id`). A card is scored 0–10 against each
scoring criterion (`card_scores`), and its rating is derived from those.

A module is a folder of `routes.ts` / `queries.ts` / `validate.ts` /
`<name>Types.ts`, plus one `app.route(...)` line in `src/index.ts`. The rule that
makes it pay off: **no module writes SQL against another module's tables.** The
one relaxation is reading across a declared foreign key -- `cards` joins `banks`
to embed the issuer name and, for a signed-in caller, `wallet_cards`; it says so
at the top of its `queries.ts`.

## Running it

```bash
nvm use                  # Node 22
npm install
cp .dev.vars.example .dev.vars
npm run migrate:local    # create the local D1 and seed the catalog
npm run dev              # http://localhost:8787
npm test
npm run typecheck
```

None of the above touches Cloudflare — local D1 is simulated by Miniflare and
persisted under `.wrangler/state/`.

## Auth

Two mechanisms, both on the `Authorization: Bearer` header:

| | Guards | Checked by |
| --- | --- | --- |
| `ADMIN_TOKEN` | catalog writes | `src/http/adminAuth.ts` |
| Clerk session token | wallets, `/v1/users/me` | `src/http/clerkAuth.ts` |
| Clerk session with `users.is_admin` | catalog writes, as an alternative to the token | `src/http/adminAuth.ts` |

`adminAuth` accepts either credential, because the admin panel is a browser and
a browser cannot hold the shared secret — every `VITE_*` value is baked into the
public bundle. It discriminates on token *shape*: a three-segment base64url JWT
goes to the session path, anything else to `hono/bearer-auth` exactly as before.

**Do not rotate `ADMIN_TOKEN` to a value containing two dots.** The recipe below
generates 43 base64url characters, which has no `.` in its alphabet, so the two
credentials cannot be confused. A JWT-shaped secret would route to the session
path and 401.

On the session path a non-admin gets **403 `forbidden`**, not 401: their
credential is valid and signing in again will not help. On the shared-token path
`c.get('user')` is `undefined` — the token identifies nobody, so there is no
audit trail behind it.

### Public profiles are the exception

`GET /v1/profiles/:handle` needs no session at all — it is the one
unauthenticated read of a person's data anywhere in this API. What it may
return is drawn narrowly: the projection in `modules/profiles/profileTypes.ts`
(`toPublicProfile`) is the security boundary, built by naming each field
rather than spreading and deleting a `StoredWallet`, so a field added there
later cannot leak through a projection that has to be edited by hand to carry
it. A handle is freed the moment its owner renames — `#/u/<old-handle>` then
resolves to whoever claims it next, deliberately; see the design doc for the
alternative considered.

### Who is an admin

`users.is_admin` (migration `0013`), granted from `ADMIN_EMAILS` — a
comma-separated **secret**, not a var, because `wrangler.jsonc` is committed to a
public repository and a var would publish which address owns the panel. For the
same reason no migration names an address.

`upsertUserByClerkId` reconciles the flag on every upsert, against the row's
*settled* email rather than the incoming identity: a session token usually
carries no `email` claim, so checking the incoming value would grant on the
webhook and never again. The write happens at most once per user.

The grant is one-way. Removing an address from `ADMIN_EMAILS` does not revoke
anything, because an identity arriving with no email must not be read as "not an
admin". Revoke by hand:

```bash
npx wrangler d1 execute ratemycards --remote \
  --command "UPDATE users SET is_admin = 0 WHERE email = '...'"
```

### The grant needs an email to have reached the row

Which is not automatic, and is the one thing that catches people out.
`users.email` is populated from two places, and **locally neither one fires**:

- The Clerk webhook always carries the primary address — but it cannot reach
  `localhost`, so it never runs in local dev.
- The session token carries an `email` claim only if the **JWT template was
  customised to add one**. Clerk's default session token has no `email` and no
  `name`.

So a fresh local database gives every user `email = NULL`, and an allowlist
match against `NULL` is correctly false — nobody is ever granted. In production
the webhook covers it.

The durable fix is to add the claim in the Clerk dashboard, under Sessions →
customise the session token:

```json
{ "email": "{{user.primary_email_address}}" }
```

That makes local dev behave like production and stops the grant depending on
webhook delivery. Until then, bootstrap a local admin by hand — set the address
and let the next request reconcile the flag:

```bash
npx wrangler d1 execute ratemycards --local \
  --command "UPDATE users SET email = '<you>' WHERE clerk_id = '<clerk id>'"
```

Session tokens are verified against Clerk's JWKS, fetched with
`CLERK_SECRET_KEY` and cached per isolate for five minutes. A token arriving
with an unseen key id forces an immediate re-fetch, so a Clerk key rotation
needs no action here. The dashboard also offers a static PEM ("legacy JWT
verification key") that would avoid the fetch; it is not used, because it knows
nothing about rotation and would 401 every request until replaced by hand.

`authorizedParties` is built from `ALLOWED_ORIGINS`, which is what stops a token
minted for a different Clerk app being spent here. Both middlewares fail closed.

`requireUser` rejects anonymous callers. `optionalUser` identifies one when a
token is present and shrugs otherwise -- that is what lets `GET /v1/cards` serve
the public catalog and a signed-in caller's view of it from one route. A
present-but-invalid token is still rejected either way, so an expired session
reads as "sign in again" rather than as a mysteriously empty wallet.

A user row appears two ways, both landing on the same upsert: the Clerk webhook
is the primary path, and `requireUser` upserts as a backstop, so a dropped
webhook self-heals on the user's next request.

The two are not interchangeable. A session token carries no profile -- `sub`,
`sid`, `azp` and timestamps, nothing else, unless extra claims are added to the
session token in the Clerk dashboard -- so the backstop can only mint a row with
a `clerk_id` on it. **Email, name and avatar come from the webhook**, which is
also the only way a deletion is ever observed: someone Clerk has deleted cannot
present a token to tell us so. That is why the upsert uses `COALESCE` -- the
sparse path must never blank what the rich one filled in. Our `id` and Clerk's `clerk_id`
both start with `user_` but are not interchangeable -- ours is 32 hex, theirs is
mixed-case base58. Everything downstream keys off ours.

## Cards API

Reads are public. Writes need `Authorization: Bearer $ADMIN_TOKEN`.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | liveness |
| `GET` | `/v1/banks` | `q`, `limit`, `offset`, `includeInactive` |
| `GET` | `/v1/banks/:id` | one bank |
| `GET` | `/v1/banks/:id/cards` | the cards that bank issues |
| `POST` | `/v1/banks` | admin — mints the id and creates the bank |
| `PATCH` | `/v1/banks/:id` | admin — partial update |
| `DELETE` | `/v1/banks/:id` | admin — soft delete |
| `GET` | `/v1/criteria` | `q`, `limit`, `offset`, `includeInactive` |
| `GET` | `/v1/criteria/:id` | one criterion |
| `POST` | `/v1/criteria` | admin — mints the id and creates the criterion |
| `PATCH` | `/v1/criteria/:id` | admin — partial update, including `weight` |
| `DELETE` | `/v1/criteria/:id` | admin — soft delete; drops out of every rating |
| `GET` | `/v1/cards` | `q`, `bankId`, `country`, `network`, `maxAnnualFee`, `ids`, `limit` (≤100), `offset`, `includeInactive` |
| `GET` | `/v1/cards/:id/networks` | admin — the card's networks and the BIN prefixes under each |
| `GET` | `/v1/cards/:id/scores` | admin — the card's score breakdown and rating |
| `PUT` | `/v1/cards/:id/scores` | admin — replaces the whole score set |
| `POST` | `/v1/wallet/preview` | scores a set of cards; stores nothing |
| `GET` | `/v1/cards/:id` | resolves inactive cards too, so a wallet holding a retired card still renders |
| `POST` | `/v1/cards` | admin — mints the id and creates the card |
| `PATCH` | `/v1/cards/:id` | admin — partial update |
| `DELETE` | `/v1/cards/:id` | admin — soft delete (`is_active = 0`) |
| `GET` | `/v1/users/me` | session — the caller's own row, and only ever their own |
| `PUT` | `/v1/users/me/handle` | session — claims or changes the public handle |
| `GET` | `/v1/handles/:handle` | whether claiming would succeed |
| `GET` | `/v1/profiles/:handle` | public — somebody's score and verified cards |
| `GET` | `/v1/networks/options` | public — the code and name of each live network, and nothing else |
| `POST` | `/v1/card-requests` | session — asks for a card, or for BINs on one |
| `GET` | `/v1/card-requests` | session — the caller's own requests, never anybody else's |
| `DELETE` | `/v1/card-requests/:id` | session — withdraws a request still waiting |
| `GET` | `/v1/card-requests/review` | admin — the queue; `status` defaults to `pending` |
| `POST` | `/v1/card-requests/:id/approve` | admin — records that the catalog now carries it |
| `POST` | `/v1/card-requests/:id/reject` | admin — `note` is required |
| `POST` | `/v1/webhooks/clerk` | signed by Clerk — keeps `users` in step |
| `GET` | `/v1/wallet` | session — the stored wallet, cards resolved and scored |
| `POST` | `/v1/wallet/merge` | session — folds local picks in; unions, never overwrites |
| `PUT` | `/v1/wallet/cards/:cardId` | session — add, idempotent |
| `PATCH` | `/v1/wallet/cards/:cardId` | session — record a verification status |
| `DELETE` | `/v1/wallet/cards/:cardId` | session — remove, idempotent, 204 |
| `POST` | `/v1/verifications` | session — mints the ₹1 order and the BIN list for one card |
| `POST` | `/v1/verifications/:id/confirm` | session — checks the payment, then releases it |

Lists return `{ "data": [...], "total": n }` where `total` ignores pagination.
Single reads return the card bare. Every failure returns
`{ "error": { "code", "message", "details"? } }`.

**Ids are minted by the server**, never supplied by the client: a prefix
(`card_`, `bank_`, `crit_`) followed by 32 hex characters from
`crypto.randomUUID()`. A request carrying its own `id` is rejected with a 400.
The seed migrations mint ids the same way, so seeded rows are indistinguishable
from ones created over the API — which also means **ids differ between
environments**. Look rows up by name, never by a hardcoded id.

The migrations seed **12 issuers and 100 Indian cards** with their published
joining and annual fees, the 7-criterion rubric below, an opening score for
every card against every criterion (700 scores), and each card's payment
networks (114 pairs) with 99 BIN prefixes across 33 of them.

⚠️ **The seeded scores are editorial judgements, not published figures.** Card
benefits move constantly, so treat them as a starting position and revise over
`PUT /v1/cards/:id/scores` — never by editing a migration, which is applied once
and never re-run. The fees are as published at the time of writing and drift the
same way.

A card embeds its issuer. It carries **no rating** — see below:

```json
{
  "id": "card_cc88ad458a6f438088e7069b9e8b407b",
  "name": "Infinia Metal",
  "bank": { "id": "bank_3b7c...", "name": "HDFC" },
  "issuer": "HDFC",
  "country": "IN",
  "joiningFee": 12500,
  "annualFee": 12500,
  "isActive": true
}
```

Fees are **whole units of the card's local currency** — rupees for `country: "IN"` —
not minor units, because every published fee is a whole number. `joiningFee` and
`annualFee` are independent: IndusInd Pioneer Legacy costs ₹50,000 to join and
nothing to hold.

`issuer` is the bank's name flattened, under the field `frontend/src/data/cards.ts`
renders. `country` lives on the card, not the bank — it is the market the card is
issued into, and an issuer like HSBC operates in several.

Because ids are random and carry no meaning, names are what identify a row:
**bank names are unique**, and **a card name is unique within its bank**. Both are
what a 409 means. Two banks may each have an "Infinia".

Deletes are soft on both tables. D1 enforces the foreign key, so a hard delete of
a bank that still has cards fails rather than orphaning them.

## Ratings are not public

The rubric, a card's per-criterion scores, and the 0–10 rating derived from them
are all internal. Nothing that identifies how good an individual card is leaves
the server:

- `GET /v1/cards` and `/v1/cards/:id` carry no `rating`.
- `GET /v1/cards/:id/scores` — the raw breakdown — requires the admin token.
- `POST /v1/wallet/preview` returns only the aggregate. A per-card `weight` is
  just its rating times a constant, so no per-card array is returned either.

Internally `listCards`/`getCard` return a `RatedCard`; `toPublicCard` in
`cards/cardTypes.ts` is the single door out, and the route layer is the only
caller. The wallet module reads the rating to compute a score and never
serialises it. Tests in `cardsRead.test.ts` assert the absence rather than
trusting the shape.

`GET /v1/criteria` is still public — it exposes the rubric's names and weights
but no card's scores, so it cannot be used to reconstruct a rating. Guard it too
if the rubric itself is meant to be private.

## Scoring

`scoring_criteria` are the dimensions cards are judged on, each with a `weight`.
The seeded rubric weights sum to 100:

| Weight | Criterion | Measures |
| -----: | --------- | -------- |
| 30 | Rewards / Returns | Effective reward rate and redemption value |
| 20 | Travel Benefits | Lounges, airline/hotel transfers, travel perks |
| 15 | Lifestyle Benefits | Hotels, dining, golf, memberships, concierge |
| 15 | Exclusivity / Prestige | Invite-only status, eligibility, perceived premium positioning |
| 10 | Milestone / Welcome Benefits | Welcome bonuses and spend milestones |
| 5 | Forex / International | Forex markup and international usability |
| 5 | Fees vs Value | Whether the benefits justify the fee |
 `card_scores` holds one card's score
against one criterion, on a **fixed 0–10 integer scale** so scores stay
comparable across the rubric.

A card's `rating` is **derived on read, never stored** — the weight-weighted
average over its scores on *active* criteria:

```
rating = Σ(score × weight) / Σ(weight)
```

So a card scoring 9 on a weight-3 criterion and 4 on a weight-1 criterion rates
7.75, not the plain mean of 6.5. Because nothing is materialised, re-weighting a
criterion or deactivating one re-rates every card immediately, with no backfill.

`score` is `null` when a card has no scores — or when every criterion it is
scored on weighs 0, which would otherwise divide by zero. Compare
`scoredCriteria` against `totalCriteria` to tell a genuine 9 from a 9 based on
one lucky criterion.

Write the whole set at once:

```
PUT /v1/cards/:id/scores
{ "scores": [ { "criterionId": "crit_…", "score": 9 },
              { "criterionId": "crit_…", "score": 4 } ] }
```

It replaces rather than merges, so repeated calls cannot accumulate duplicates,
and `{ "scores": [] }` clears the card.

## Networks and BINs

A payment network is a row, not an enum. Four tables, all in `0009`:

| table | holds |
|---|---|
| `networks` | `id`, `code` (`'visa'`), `name`, `is_active` |
| `network_bin_rules` | the ISO/IEC 7812 prefix rules each network allocates under |
| `card_networks` | the `(card_id, network_id)` pair |
| `card_bins` | the prefixes hanging off one pair |

A card sold as both a Visa and a Mastercard has a row per variant, and each
variant has its own prefixes.

`code` is what the API speaks, in both directions. `network_id` never leaves the
server.

### Managing them

`/v1/networks` is **admin-only throughout, reads included** — which departs from
`/v1/banks` and `/v1/cards`, where `GET` is public. Nothing public consumes it:
the frontend calls only `/v1/cards`, `/v1/wallet*` and `/v1/verifications*`, and
no screen shows a network. Publishing it later is a one-line change; retracting
it once a client depends on it is not.

```
GET    /v1/networks       ?q= ?includeInactive= ?limit= ?offset=
GET    /v1/networks/:id
POST   /v1/networks       { code, name, binRules, isActive? }
PATCH  /v1/networks/:id
DELETE /v1/networks/:id   soft delete
```

`binRules` is `[{ kind: 'glob' | 'range', value }]`. A `glob` is SQLite GLOB
syntax restricted to digits, `[`, `]`, `-` and `*` (`'4*'`, `'5[1-5]*'`); a
`range` is two four-digit inclusive bounds compared against the prefix's first
four digits (`'2221-2720'`). `POST` requires at least one rule — a network with
none is one no BIN can be added under. `PATCH` replaces the whole set, like
`PUT /v1/cards/:id/scores`; omitting it leaves the rules alone and `[]` clears
them.

A soft-deleted network keeps its `card_networks` rows and keeps working as a
`?network=` filter value. What changes is that card writes reject it.

### Writing a card's networks and BINs

Both in one call, so an admin creates a complete card at once:

```
PATCH /v1/cards/:id
{
  "networks": [
    { "code": "visa",       "bins": ["412345", "45678901"] },
    { "code": "mastercard", "bins": ["521234"] }
  ]
}
```

This replaces the card's whole network **and** BIN set rather than merging.
Omitting `networks` leaves both untouched. `networks: []` means "on no networks"
and clears both — the way back for a card entered wrong. A network with `bins:
[]` is a real state: the card runs on it, but no prefix is on file, so the card
is not selectable.

There is no 409 for dropping a network that still has BINs. The caller states
both halves, so there is no unmentioned data to protect.

### Why the prefix rules are not a CHECK

They were, in the first draft of `0009`: the whole ISO/IEC 7812 table in one
constraint on `card_bins`, in the one place no write path could bypass. That
stops working the moment networks are rows an admin can add, because a `CHECK`
cannot subquery a table. The rules moved to `network_bin_rules`, enforced by
`modules/networks/binRules.ts` via `cards/validate.ts`.

A glob is validated for **structure**, not merely for which characters it may
contain. `GLOB_SHAPE` in `binRules.ts` admits digits, `*`, and character classes
holding digits and ascending digit ranges — nothing else. That is what makes
translating a glob straight into a `RegExp` safe.

The alphabet alone was not enough, and the gap was not hypothetical. `4[` and
`4[9-0]*` pass a character-set test and then throw at `RegExp` construction.
`4[]5]*` is worse: it passes and does *not* throw. SQLite `GLOB` reads a `]`
immediately after `[` as a literal class member, so that pattern matches real
prefixes — while JavaScript reads `[]` as an empty class that matches nothing at
all. A rule that silently never fires is harder to notice than a crash.

`GLOB_SHAPE` is therefore deliberately **stricter** than the `CHECK` on
`network_bin_rules`. SQLite `GLOB` cannot express well-formedness, so this is the
one place the project's "validator mirrors the constraint" rule does not hold: the
constraint is a coarse character backstop, and `isBinRuleValue` is the real gate.
Do not loosen it to restore the symmetry.

### Cards with no BINs are not selectable

`GET /v1/cards` hides them. The rule is **discovery-scoped, not
resolution-scoped**:

| request | gated |
|---|---|
| `GET /v1/cards` — browse, search | yes |
| `GET /v1/cards?ids=…` | no |
| `GET /v1/cards/:id` | no |
| `GET /v1/cards?includeUnselectable=true` | no |
| `getWallet`, `POST /v1/wallet/preview`, `knownCardIds` | no |

`?includeUnselectable=true` requires no authentication. It exposes nothing
secret — card names are public, and BIN prefixes are still never serialised onto
a card — but the admin panel needs it because a card must be findable to be
fixed.

The carve-out is not a convenience. Three call sites resolve wallets through
`listCards({ ids })` — `getWallet`, `POST /v1/wallet/preview`, and
`knownCardIds` — so gating them would drop held cards out of a wallet and change
its score. The prune listener in `frontend/src/store/store.ts` then deletes any
picked card the catalog stops returning, permanently, from the browser's persisted
copy.

Note what the `ids` carve-out does **not** cover. It bypasses the BIN gate only,
never `is_active`: a card whose bank was deactivated does not resolve by `ids`
alone. Wallet resolution survives that because those same three call sites also
pass `includeInactive: true`. Both flags carry weight independently, and dropping
either one would eat wallets.

Only 34 of the 100 active seeded cards have BIN rows. Wallets already holding
the other 66 keep them, keep their verification status, and keep scoring.

Six more cards carry prefixes while sitting **inactive** -- Axis Neo, HDFC Times
Card, Kotak Cashback+, BOBCARD Tiara, DBS Vantage and SBI Reliance PRIME, seeded
by 0018. They are dark on purpose. A card needs a fee and seven rubric scores
before it can be honestly ranked, and none of that is in a BIN list; worse,
`cardWeight(null)` is 0 while `scoreWallet` still pays the 60-point multi-card
bonus, so an unscored card is 60 free points to anyone holding it. Inactive
keeps them out of browse, so out of wallets, so out of scoring -- and their
prefixes are already on file for whenever somebody prices and scores them
through the admin panel. `cardsRead.test.ts` guards that they stay that way.

**The picker no longer hides them, though the API still does.** The gate here is
about what browse *returns*; the frontend now asks with
`includeUnselectable: true` and renders those cards greyed, marked "Can't verify
yet", with an offer to ask for their prefixes. Hiding them made the backlog
invisible to the only people who can close it — somebody holding one of those
cards knows its prefixes and could not tell us, because they could not find the
card. See "Card requests" below.

One consequence worth knowing, because it is not obvious: a wallet can now hold
a card that nothing can ever verify, so "everything verified" has to exclude
them or the reveal button never unlocks. `primaryCta` in
`frontend/src/data/scoring.ts` takes a `blockedCount` for exactly that.

`GET /v1/cards?includeInactive=true` also now reveals cards whose *bank* was
deactivated. Before this, `buildWhere` checked `c.is_active` but never
`b.is_active`, so removing a bank left all its cards in the catalog.

### Who reads the prefixes

`cards.listCardNetworks` is the one door: a card's networks with the prefixes
behind each, never serialised onto a card. It has two callers.

(`GET /v1/networks/options` is public, but reads none of this: it publishes each
live network's code and display name and nothing else — no id, no `binRules` —
so a card-request form can ask which network somebody's card runs on without a
second copy of the eight codes living in the bundle.)

`POST /v1/verifications` hands out just the one card's list so Checkout can
narrow to it. `GET /v1/cards/:id/networks` serves the admin panel, and is
guarded on the read as well as the write — there is deliberately still no
*public* way to reach a prefix. That endpoint exists because
`PATCH /v1/cards/:id { networks }` replaces the set rather than merging into it:
an editor that could not read the current set would silently destroy it on every
save.

That list does reach the browser, which is unavoidable: Checkout is configured
client-side. It does not weaken anything, because knowing the accepted prefixes
is not what passes verification — you still need a real card from that issuer and
network, and the check runs server-side against Razorpay's account of the
payment. What would be unsafe is publishing prefixes on the card itself and then
trusting a client-submitted BIN; that is the design this avoids.

### How much a BIN actually tells you

The leading digits of a card number are the IIN (ISO/IEC 7812), universally
called the BIN. The first digit is the Major Industry Identifier — which is why
every Visa starts `4` and every Amex `34` or `37` — and digits 1–8 are the block
the network allocated to one issuer, sub-allocated by that issuer per funding
type and product tier.

Two consequences worth knowing before building on this:

- **A BIN identifies issuer + network + tier, not a product.** No public dataset
  resolves "which rewards card". So `card_bins` holds the prefixes of the tier
  block the product belongs to — a *superset*. Matching one proves the issuer,
  network and tier; it does not prove the specific card. Two cards in a tier
  share prefixes, which is why there is no `UNIQUE` on `bin_prefix`.
- **Prefix → network is ambiguous.** `65` is both RuPay and Discover, `81` both
  RuPay and UnionPay. Consult the join from `card_networks` to `networks`; do
  not infer.

Coverage is partial on purpose: 34 of the 100 seeded cards have BIN rows. A tier
block wider than 8 prefixes is left out, because SBI's 25 Visa Platinum prefixes
shared across most of the portfolio assert nothing about any one card. Prefixes
are real, from the open dataset at `github.com/venelinkochev/bin-list-data`; the
network-to-card assignments are editorial, like the fees in `0005`.

## Card verification

Holding a card is not something an API can be told, only shown. So a card is
proved by authorising **₹1** on it through Razorpay Standard Checkout and giving
it straight back. Two calls with the Checkout modal in between:

```
POST /v1/verifications            { "cardId": "card_…" }
→ 201 { "verificationId": "ver_…", "keyId": "rzp_test_…",
        "orderId": "order_…", "amount": 100, "currency": "INR",
        "cardName": "Infinia Metal", "issuer": "HDFC",
        "allowed": { "iins": ["417410","436152","437546"], "networks": ["visa"] } }

  (browser opens Checkout, person pays with their real card)

POST /v1/verifications/:id/confirm
     { "razorpay_payment_id": "pay_…", "razorpay_order_id": "order_…",
       "razorpay_signature": "…" }
→ 200 { "status": "verified", "releaseState": "voided",
        "card": { "network": "Visa", "last4": "4321", … } }
→ 422 { "status": "mismatched", "reason": "network_mismatch:mastercard", … }
```

`allowed.iins` narrows the Checkout modal to this card's own plastic. **It is not
the check.** That options object is assembled in the browser and can be edited
there, so `confirm` re-reads the payment from Razorpay and decides from that.

### What confirm actually verifies

1. **The signature** — HMAC-SHA256 of `<order_id>|<payment_id>` keyed with the
   key secret. Without it anyone could POST an order/payment pair, since the
   browser is told both.
2. **The order** — the callback's order id, and Razorpay's own record of which
   order the payment settled against, must both match the attempt.
3. **The card** — `GET /v1/payments/:id/card`, and its `network` must be one the
   card is on.

Only the network is enforced, and that is a real limit worth knowing: **Razorpay
never reports the card's BIN.** The payment's card entity carries `last4`,
`network`, `type` and `issuer`, nothing more. A BIN only resolves issuer +
network + tier anyway (see `0009`), so verification is honest at exactly the
resolution the data has — "this is a Visa credit card from this issuer", never
"this is specifically an Infinia". `issuer` is recorded but not enforced:
Razorpay reports 4-character bank codes (`UTIB` for Axis) and mapping those onto
the catalog's twelve bank names is a table that does not exist yet, so enforcing
it on a guess would reject real cards.

### Where the money goes

Orders are created with `payment_capture: 0`, so the rupee is **authorised and
never captured**. Razorpay voids an uncaptured authorisation within 3–5 days and
an uncaptured payment attracts no MDR — that is the cheap path, recorded as
`releaseState: "voided"`. An account configured to auto-capture overrides this;
the payment then arrives captured and the only way back is an explicit refund,
recorded as `"refunded"`. Their docs are explicit that *fees charged for a
captured payment are not reversed*, so that path costs the MDR per verification.
Worth confirming the fee treatment of the uncaptured path with Razorpay support
before relying on it in production.

The rupee is released whether the card matched or not — a mismatch is not a
reason to keep someone's money.

### Replay protection

`card_verifications.razorpay_payment_id` carries a UNIQUE index. Without it one
successful rupee could be replayed against every card in the catalog; with it,
one payment verifies one card, once, and a second attempt is a 409.

### Not built yet

There is **no Razorpay webhook**. If someone closes the tab between paying and
confirming, the attempt stays `created` and the ₹1 auto-voids in a few days —
the card simply is not verified and can be retried. A webhook on
`payment.authorized` would settle those; it is the obvious next piece.

## Card requests

Two thirds of the catalog has no BIN prefixes on file, and the catalog will
never carry every card in India. Both are dead ends somebody hits with no way to
tell us. `card_requests` is that way: a signed-in person asks for a card we do
not carry (`kind = 'card'`) or for the prefixes on one we do (`kind = 'bin'`),
and an admin works the queue at `#/admin/requests`.

**Approving writes nothing into the catalog.** The admin creates the bank, the
card and the prefixes through `/v1/banks` and `/v1/cards` — which already
validate all of it against `networks/binRules.ts` — and *then* calls approve,
which records that it happened. Everything on a request is a claim: the issuer
may be spelled three ways, the network may be wrong, and a prefix read off
somebody's own plastic is a guess about a product family. None of it is allowed
near the catalog unedited.

That also means approval is **three unrelated HTTP calls with no transaction**.
If the card is created and the approve then fails, the catalog has the card and
the request is still pending. That is benign — the admin retries approve with
the same `cardId` — and it is the honest description: approval is bookkeeping
over work that already happened, and its check is a guard rail against a typo,
not a transaction.

### What approval does and does not check

The gate is **existence and active**, and nothing else. `cards.getCard` resolves
inactive cards on purpose, so approving against a soft-deleted card is refused
explicitly rather than by accident.

It deliberately does **not** require the card to have any BIN prefixes. A card
with none is a supported state — see "Cards with no BINs are not selectable"
above — so requiring them would wedge the queue whenever the data is not to
hand, and push an admin towards inventing a prefix to clear it, straight into
`card_bins`, which is the table a ₹1 verification matches against. The approve
response returns `selectable` instead, and the screens say *"added, it will
appear once we have its prefixes"* in words. Honesty here is a copy problem, not
a constraint problem.

It also does **not** require the prefixes that were asked for to be the ones
recorded. A requester guesses `412345`; the admin knows the real prefix is
`414767` and records that. A check on the requested value would refuse to
approve a request the admin had fully honoured.

### Adding a prefix is always read–merge–replace

`PATCH /v1/cards/:id { networks }` **replaces**, and `replaceNetworks` opens
with an unconditional `DELETE FROM card_bins WHERE card_id = ?` — all of them,
before it looks at what you sent. Sending one network with one prefix therefore
wipes every other network and prefix on the card, returns 200, flips
`selectable` to false, drops the card out of the picker, and **breaks
`POST /v1/verifications` for every user already holding it**, because that route
refuses a card with no networks or no prefixes.

So the worst case of approving a request is a silent verification outage for
existing holders. Read the current set with `GET /v1/cards/:id/networks`, merge
into it, send it all back. The console does this in one place —
`mergeCardBins` in `frontend/src/data/adminApi.ts` — and nothing else may call
`replaceCardNetworks` to *add* something.

### Who reviewed it

`card_requests.reviewed_by` is nullable, and that is not an oversight.
`adminAuth` accepts either a Clerk session or the shared `ADMIN_TOKEN`, and on
the token path `c.get('user')` is undefined — the token identifies nobody. Every
review from the console carries an admin; every review by curl or the test suite
carries none.

### Keeping the queue honest

Sign-in is the real gate. On top of it: two partial unique indexes (one open
request per person per card, and per issuer+product, `COLLATE NOCASE`), a cap of
ten open requests per person, and `DELETE` as the release valve — without it a
typo strands somebody until an admin acts. A `card` request naming a product
that already exists under a resolved issuer is refused at submit, because that
is the same 409 `idx_cards_bank_name` would produce two steps later.

Cross-user duplicates are **not** deduplicated: ten people asking for the same
card is the most useful thing in the table. The review list orders by issuer and
product so identical asks cluster, and the counts are never published — a public
"23 people want this" endpoint is a free roadmap scrape.

One thing to know: a typed issuer is matched case-insensitively against existing
banks and adopted on an exact hit. That matters because `idx_banks_name` is a
plain UNIQUE under SQLite's default BINARY collation, so `HDFC` and `hdfc` can
already both exist as banks — and this feature hands people a keyboard pointed
straight at that. Normalising at submit stops it getting worse; fixing the index
is a separate migration.

## Wallets

An anonymous visitor's wallet is just a set of card ids held in their browser,
and `/v1/wallet/preview` asks the API what they are worth without storing
anything:

```
POST /v1/wallet/preview   { "cardIds": ["card_…", "card_…"] }
→ { "score": 1448, "maxScore": 3000,
    "tier": { "name": "Specialist", "color": "#60A5FA", "min": 1400 },
    "cardCount": 2, "unknownIds": [] }
```

```
score = 620 + Σ round(rating × 50) + 60 × (cards − 1),  capped at 3000
```

An empty wallet scores 0 rather than the base. A card's 0–10 rating scales into
the 0–500 band the tier ladder was built around, so re-rating a card moves every
wallet holding it. `unknownIds` names ids the API did not recognise, so a client
holding stale local state can prune it. Retired cards still score — nobody
should silently lose points because the catalog moved on.

**This endpoint is the only implementation of the formula.** The frontend used
to carry a copy; it now reads the score from here so the two cannot drift.

### Stored wallets

Signing in turns that set of ids into rows in `wallet_cards`. `POST
/v1/wallet/merge` runs once at sign-in and *unions* the browser's picks with
whatever the account already held: a card already on the server keeps the
verification it earned, so a fresh device cannot downgrade it. After that the
client writes through on every change, and the server is the source of truth.

**That trust gap is closed.** `PATCH /v1/wallet/cards/:cardId` now refuses
`status: "verified"` with a 400 — a card becomes verified only by completing the
Razorpay flow below, which checks a real payment. The other three statuses stay
writable: they are the client reporting what it saw, and none of them grants
anything. The `verified_at` timestamp is still the server's to set, and a CHECK
constraint keeps it absent for every status but `verified`.

**A verification outlives the wallet row that displayed it.** `wallet_cards`
carries the status the screens read; `card_verifications` carries the payment
that earned it, and removing a card deletes only the first. So a wallet row is
born from the evidence — remove a verified card, add it back, and it comes back
verified, dated when the rupee was actually paid — and no status write may take
that back afterwards. Both halves are needed: with neither, the two tables
disagree in the worst possible direction, the wallet offering a Verify button
while `POST /v1/verifications` answers "already verified" and refuses to take a
second rupee for a card that is already proved. Migration 0015 is the one-off
repair for rows that drifted apart before this held.

For a signed-in caller, each card from `GET /v1/cards` also carries a `wallet`
block — `inWallet`, `verificationStatus`, `verifiedAt`. It is absent entirely
for anonymous callers, so the public response shape is unchanged.

## Deploying

Needs a Cloudflare login, which is interactive:

```bash
npx wrangler login
npm run db:create        # writes the real database_id — paste it into wrangler.jsonc
npm run migrate:remote
npm run secret:admin     # paste a generated token; never pass it as an argument
npm run deploy
```

Generate a token with:

```bash
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"
```

`wrangler deploy` refuses to ship if `ADMIN_TOKEN` is unset — see
`secrets.required` in `wrangler.jsonc` — so a deployment cannot come up with its
writes unguarded.

### Continuous deployment

`.github/workflows/deploy.yml` deploys on every push to `main` (and can be run
manually). It applies pending D1 migrations before deploying the Worker, and
publishes the frontend to GitHub Pages.

Before the first workflow run:

1. Create the D1 database and replace the placeholder `database_id` in
   `wrangler.jsonc` with its real ID.
2. Create a GitHub Environment named `backend`, then add these Environment
   secrets:
   - `CLOUDFLARE_API_TOKEN` — permission to deploy Workers, update the
     `ratemycards` D1 database, and manage the `manishbisht.me` zone.
   - `WORKER_SECRET_ADMIN_TOKEN` — published to the Worker as `ADMIN_TOKEN`.
3. Add backend Environment protection rules if migrations and Worker releases
   need approval.
4. In GitHub repository settings, choose **GitHub Actions** as the Pages source
   and associate `ratemycards.manishbisht.me` as the custom domain.

The Worker custom domain is `api-ratemycards.manishbisht.me`; the API allows
cross-origin requests only from `https://ratemycards.manishbisht.me` and the
two local Vite origins.

Worker runtime secrets use the convention `WORKER_SECRET_<NAME>` in the GitHub
Environment and `<NAME>` in the Worker. Each secret is mapped explicitly in
the deployment workflow, then uploaded with Wrangler's `--secrets-file` option.
When adding a secret, add its Environment secret, map it in
`.github/workflows/deploy.yml`, and add its Worker binding name to
`secrets.required` in `wrangler.jsonc` if application code requires it.

## Migrations

Applied once, in filename order, tracked in `d1_migrations`, never rolled back.
Editing a migration that has already been applied remotely does nothing. Always
add a new numbered file:

```bash
npx wrangler d1 migrations create ratemycards someChange
```
