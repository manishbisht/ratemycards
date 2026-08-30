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

The app gates itself to viewports ≤ 700px wide (`DesktopGate`), so use a narrow
window or device emulation.

## Where things live

```
src/
  data/      cards.ts (the Card type)  api.ts (the API client)
             scoring.ts (derived copy)  handles.ts  verification.ts
             — no tier ladder: the API returns the tier with the score
  store/     Redux Toolkit store, slices, selectors, persistence, typed hooks
  state/     wallet types and useWalletScore — debounced preview dispatches
  pages/     one per route; `#/wallet` is CardPickerPage
  components/ router/ hooks/ styles/
```

## How the wallet works

The wallet is **client-side only**: `state.picked` holds card ids in
`localStorage` under `ratemycards.wallet.v2`. There is no account and nothing is
sent to the server except the ids, in exchange for a score.

- The Redux catalog slice is loaded when the app starts; search remains local
  to the picker and re-queries the API, debounced, so the list always reflects
  the live catalog.
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
