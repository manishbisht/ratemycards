# Rate My Cards — frontend

Vite + React 19, Redux Toolkit, mobile-only, hash-routed.

Requires **Node >= 22** (`nvm use` at the repo root).

## Running it

The app reads the catalog and its score from the Workers API, so both need to be
running:

```bash
# terminal 1 — the API
cd backend && npm run migrate:local && npm run dev   # :8787

# terminal 2 — the app
cd frontend && npm install && npm run dev            # :5173
```

`VITE_API_BASE_URL` is required and points the app at the API. Copy
`.env.example` to `.env.local` and set it for local development. The API's CORS
allowlist lives in `backend/wrangler.jsonc` under `ALLOWED_ORIGINS` — a new
frontend origin has to be added there too.

## Deployment configuration

The GitHub Pages deployment reads `VITE_API_BASE_URL` from the `github-pages`
GitHub Environment. Set it to `https://api-ratemycards.manishbisht.me` for
production. The workflow fails rather than deploying if it is missing.

Every `VITE_*` value is embedded in the browser bundle at build time. Treat
these as public configuration: never put private credentials, tokens, or other
secrets in them. Map each new `VITE_*` Environment secret explicitly in
`.github/workflows/deploy.yml` so the build's public configuration is reviewable.

The app is drawn as a phone screen. On anything wider it runs as a 390px column
centred in the window (`PhoneFrame`), with the backdrop and its glows showing
either side; on a phone the column is the whole screen. That is pure CSS — a
`max-width` that simply does not bind below 390px — so there is one code path
for both and nothing remounts when a window is resized. Develop at whatever
width suits you.

`#/admin` is the exception, and the only place left that refuses a viewport
outright — see below.

## The admin console

`#/admin` is a desktop-only console for editing the catalog: banks, the cards
each bank issues, the networks a card runs on with their accepted BIN prefixes,
the network list itself, and the scoring rubric. It lives in `src/admin/` and
replaces the page tree rather than mounting inside it, so none of the phone
chrome — the `PhoneFrame` column, `AuthBar`, `Screen` — comes along.

| Route | Screen |
| --- | --- |
| `#/admin`, `#/admin/banks` | banks, and the new-bank form |
| `#/admin/banks/<bankId>` | one bank and the cards it issues |
| `#/admin/cards/<cardId>` | a card's fields, its networks + BINs, its scores |
| `#/admin/networks` | payment networks and their BIN prefix rules |
| `#/admin/criteria` | the scoring rubric |
| `#/admin/requests` | cards and BIN prefixes people have asked for |

`AdminGate` wants **≥ 900px** and refuses below it, because a master-detail
with tables in it has a floor the app does not. Access comes from
`GET /v1/users/me` → `isAdmin`, which the backend grants from its `ADMIN_EMAILS`
secret; a signed-in non-admin sees a "No access" panel rather than a fake 404,
because the route table ships in the public bundle and obscurity would buy
nothing.

Two contracts worth knowing before editing these screens: a card's `networks`
and a card's `scores` are both **replaced** by their save, never merged, so the
forms always post the complete set; and every admin card list passes
`includeUnselectable=true`, without which the 66 seeded cards that have no BIN
prefixes are invisible to the only tool that can give them some.

The requests queue leans on the first of those hard enough to be worth its own
warning. Approving a request writes **nothing** to the catalog — the screen
creates the bank and the card through the ordinary endpoints first, and approve
only records that it happened. Adding a BIN prefix goes through `mergeCardBins`
in `data/adminApi.ts`, which reads the card's whole network set and sends it all
back; calling `replaceCardNetworks` with just the new prefix would delete every
other prefix on the card, return 200, and break verification for everyone
already holding it.

## Where things live

```
src/
  data/      cards.ts (the Card type)  api.ts (the API client)
             scoring.ts (derived copy)  handles.ts  verification.ts
             cardRequests.ts (request types and the copy for a settled one)
             — no tier ladder: the API returns the tier with the score
  store/     Redux Toolkit store, slices, selectors, persistence, typed hooks
  state/     wallet types and useWalletScore — debounced preview dispatches
  pages/     one per route; `#/wallet` is CardPickerPage
  admin/     the desktop console behind `#/admin` — its own gate and chrome
  components/ router/ hooks/ styles/
```

## How the wallet works

The wallet is **client-side only**: `state.picked` holds card ids in
`localStorage` under `ratemycards.wallet.v2`. There is no account and nothing is
sent to the server except the ids, in exchange for a score.

`state.handle` is the exception, and lives on the same slice only for
convenience. The public handle itself is **server-owned** — claimed through
`PUT /v1/users/me/handle`, unique across all users, and hydrated into this
slice from `GET /v1/users/me` at sign-in (`useClerkUserSync`), so it survives
clearing `localStorage` or signing in on a different device. `ProfilePage`
still renders your own profile straight from this local copy rather than
fetching it, so it stays instant and correct while a claim is still settling;
anyone else's profile is fetched from `GET /v1/profiles/:handle`.

- The Redux catalog slice is loaded when the app starts; search remains local
  to the picker and re-queries the API, debounced, so the list always reflects
  the live catalog.
- **The picker shows cards it cannot verify.** Two thirds of the catalog has no
  BIN prefixes on file. Those rows used to be filtered out; they now render
  greyed and marked "Can't verify yet", and a held one offers to ask for its
  prefixes at `#/requests`. Hiding them kept the backlog away from the only
  people who can close it. Because a wallet can now hold a card nothing can ever
  verify, `primaryCta` and `verifyLine` in `data/scoring.ts` take a
  `blockedCount` and exclude those from "everything verified" — without it the
  Reveal button would never unlock.
- **The picker never shows or fetches a rating.** The score is masked until the
  user presses Reveal; `useWalletScore` is called by the screens that display a
  score (reveal, verify, profile), not by the provider, so the picker issues no
  preview request at all.
- The score comes from `POST /v1/wallet/preview` — the formula lives in the
  backend only. The score slice stores API results while `useWalletScore`
  debounces dispatches and keeps the previous score on screen while a new one
  is in flight, so the number never flickers to zero.
- The API publishes no per-card rating, so `Card` has none: the list rows show
  name and issuer only, and the fanned deck shows the last four cards added
  rather than ranking them.
- Ids that the catalog no longer recognises are pruned on load, so a wallet
  cannot quietly score zero after a card is removed.

`Card.short` is derived in `api.ts` rather than stored: the API models a card as
a product plus a bank, while the deck tiles want a two-line label.
