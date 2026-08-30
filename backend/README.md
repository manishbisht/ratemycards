# ratemycards API

Cloudflare Workers API for Rate My Cards. Hono for routing, D1 (SQLite) for
storage, no ORM.

Requires **Node >= 22** — Wrangler 4.87+ exits on anything older. `.nvmrc` at the
repo root pins it; run `nvm use`.

## Modules

| Module | Path | Owns |
| ------ | ---- | ----- |
| banks   | `src/modules/banks/` | `banks` — card issuers |
| cards   | `src/modules/cards/` | `cards` — the catalog of supported cards |
| scoring | `src/modules/scoring/` | `scoring_criteria`, `card_scores` — the rubric |
| wallet  | `src/modules/wallet/` | no tables — scores a set of cards on the fly |

A bank has many cards (`cards.bank_id`). A card is scored 0–10 against each
scoring criterion (`card_scores`), and its rating is derived from those.

A module is a folder of `routes.ts` / `queries.ts` / `validate.ts` /
`<name>Types.ts`, plus one `app.route(...)` line in `src/index.ts`. The rule that
makes it pay off: **no module writes SQL against another module's tables.** The
one relaxation is reading across a declared foreign key -- `cards` joins `banks`
to embed the issuer name, and says so at the top of its `queries.ts`.

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
| `GET` | `/v1/cards` | `q`, `bankId`, `country`, `maxAnnualFee`, `ids`, `limit` (≤100), `offset`, `includeInactive` |
| `GET` | `/v1/cards/:id/scores` | admin — the card's score breakdown and rating |
| `PUT` | `/v1/cards/:id/scores` | admin — replaces the whole score set |
| `POST` | `/v1/wallet/preview` | scores a set of cards; stores nothing |
| `GET` | `/v1/cards/:id` | resolves inactive cards too, so a wallet holding a retired card still renders |
| `POST` | `/v1/cards` | admin — mints the id and creates the card |
| `PATCH` | `/v1/cards/:id` | admin — partial update |
| `DELETE` | `/v1/cards/:id` | admin — soft delete (`is_active = 0`) |

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
joining and annual fees, the 7-criterion rubric below, and an opening score for
every card against every criterion (700 scores).

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

Networks (Visa / Mastercard / RuPay and their variants) are not modelled yet;
they arrive in a later migration.

## Wallet preview

A wallet is just a set of card ids. There is no wallets table and no accounts
yet — the client keeps its own ids and asks the API what they are worth:

```
POST /v1/wallet/preview   { "cardIds": ["card_…", "card_…"] }
→ { "score": 1448, "maxScore": 3000,
    "tier": { "name": "Specialist", "color": "#60A5FA", "min": 1400 },
    "cardCount": 2, "cards": [ … ], "unknownIds": [] }
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
