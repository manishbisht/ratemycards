# An admin who is a person, and a console to be one in

Design, 2026-09-01.

## Why

`2026-08-31-cards-networks-bins-design.md` made banks, cards, networks and BIN
prefixes all editable data, and closed with *"Out of scope: the admin panel
itself. This makes the API it will need."* This is that panel.

Two things stood between the API and a browser:

1. **There was no admin user.** `adminAuth` was one shared `ADMIN_TOKEN`, with no
   identity behind it and no way for a browser to hold it: every `VITE_*` value
   is baked into the public bundle at build time.
2. **The app is mobile-only.** `DesktopGate` unmounts the whole page tree above
   700px. A console is the exact inverse.

## Decisions

| Question | Decision |
|---|---|
| How does a browser authenticate as an admin? | `adminAuth` accepts a Clerk session whose user row has `is_admin`, alongside the existing token. |
| How does it tell the two apart? | Token *shape*. A three-segment base64url JWT is a session; anything else takes the untouched `bearerAuth` path. |
| Where does `is_admin` come from? | An `ADMIN_EMAILS` allowlist, reconciled on upsert. |
| `ADMIN_EMAILS`: var or secret? | Secret. The repo is public. |
| Does a migration name the admin address? | No. Same reason, and git history would keep it. |
| Signed-in non-admin | 403 `forbidden`, a new error code. |
| Route style | Hash routes. GitHub Pages has no SPA fallback. |
| Delete | Soft, and labelled *Deactivate*, with a *show inactive* toggle and *Reactivate*. |
| Admin state in Redux? | No. Local state per screen. |

## Auth

### Two credentials, one middleware

```
adminAuth:
  token = the value after "Bearer " (single space, case-insensitive scheme)

  if token is JWT-shaped:                    /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2}$/
      user = resolveUser(...)                --> 401 if it does not verify
      if !user.isAdmin: 403 forbidden
      c.set('user', user); next()

  else:                                      --> unchanged
      if !ADMIN_TOKEN: 401 "not configured"
      bearerAuth({ token: ADMIN_TOKEN })
```

Routing on shape rather than trying one and falling back is what keeps the
shared-secret branch byte-identical, and that matters more than it looks.
`hono/bearer-auth` hashes both sides before comparing, so a wrong-length token
is a 401 rather than the 500 `workerd`'s `timingSafeEqual` would throw; and a
header missing the scheme is RFC 6750's 400 `invalid_request`, not a 401. Both
are pinned by `test/auth.test.ts`, **which was not modified**. If it ever needs
to be, this design is wrong.

The discriminator cannot collide with a real secret: `README.md`'s recipe
generates 43 base64url characters, an alphabet with no `.`. That is now a stated
rotation constraint rather than a happy accident.

| Credential | Result |
|---|---|
| absent | 401, with the `WWW-Authenticate` challenge |
| no `Bearer` scheme | 400 `invalid_request` |
| wrong token, any length | 401 |
| correct `ADMIN_TOKEN` | passes; `c.get('user')` is `undefined` |
| JWT that does not verify | 401 |
| valid session, `is_admin = 0` | **403 `forbidden`** |
| valid session, `is_admin = 1` | passes; `c.set('user', …)` |

Two consequences, both accepted. The `!ADMIN_TOKEN` fail-closed check now runs
*after* the session branch, so each credential fails closed independently and a
deployment with no shared secret still admits a session admin. And the shared
token still identifies nobody, so anything that later wants to record *who*
changed a card has to handle that — `Variables.user` being optional already
forces the check.

### 403

`ErrorCode` gains `forbidden`. 401 and 403 want opposite things from a client:
one means present a credential, the other means the one you presented will never
work. Collapsing them would have the console tell a mis-provisioned admin to
sign in again, forever.

### The grant

```sql
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0
  CHECK (is_admin IN (0, 1));
```

`upsertUserByClerkId` reconciles it against `ADMIN_EMAILS` on every upsert, and
the *settled* email — the row's, after `COALESCE` — not `identity.email`. That
distinction is the whole mechanism: a Clerk JWT template need not carry an
`email` claim and usually does not, so checking the incoming value would grant
on the webhook and never again, and would make every claimless request look like
"not an admin".

Grant-only, for the same reason: an identity arriving with no email must not
revoke. Dropping an address from the allowlist therefore does nothing until
someone runs the `UPDATE` in `backend/README.md`.

The write is guarded on `!user.isAdmin`, so it happens at most once per user and
the steady state is still one statement per authenticated request.

**No address appears in any committed file.** `ADMIN_EMAILS` is a Worker secret
handled exactly like `ADMIN_TOKEN` — `wrangler.jsonc`'s `secrets.required`, the
deploy workflow's guard, `.dev.vars.example` — rather than a var, because
`wrangler.jsonc` is committed to a public repository. `0013` does not backfill
by email for the same reason; the reconcile covers existing rows on their next
authenticated request.

## `GET /v1/cards/:id/networks`

The one new endpoint. `toPublicCard` strips networks and BINs, and there was no
other read, so the editor had nothing to edit from.

Admin-guarded on the read as well as the write. This does not soften the
argument in `README.md`'s "Who reads the prefixes": that was never *prefixes are
unreadable* — `POST /v1/verifications` already ships one card's list to the
browser, because Checkout is configured client-side. It was *prefixes are not on
the public card, and a client-submitted BIN is not trusted*. Both still hold.

It is not optional. `PATCH /v1/cards/:id { networks }` replaces the whole set, so
a UI that could not read the current one would silently delete it on every save.

Body is `listCardNetworks` verbatim — no new SQL — in the `{ data, total }`
envelope every other list uses.

## Frontend

### Shape

`#/admin/*` replaces the page tree rather than mounting inside it:

```tsx
if (isAdminRoute(route)) return <AdminApp route={route} />
return <DesktopGate>{…the phone app…}</DesktopGate>
```

`isAdminRoute` is a type predicate, so `renderRoute` can be typed
`Exclude<Route, AdminRoute>` and its switch becomes genuinely exhaustive. It was
not before: with no declared return type, a new route kind rendered `undefined`
— a blank screen, no compile error. `hrefFor`'s `default` branch had the mirror
problem, silently emitting `#/adminNetworks` for a route `parseHash` would never
match; it now lists every kind and has no `default`.

`AdminGate` wants ≥ 900px against `DesktopGate`'s ≤ 700px, leaving a deliberate
band where neither runs — a tablet is told rather than shown a broken table. A
separate component rather than a mode on `DesktopGate`: they share a mechanism
and nothing else.

### State

No Redux and no query cache. The store is persisted wholesale to `localStorage`
on every dispatch and carries a prune listener keyed on the catalog; admin rows
have no business in that machinery. A cache is actively wrong here — after a
write the console must show what the server now holds.

`useAdminResource(load, key)` is the whole data layer: one read, its states, and
`reload`. The key is passed explicitly because `load` is a fresh closure every
render and there is nothing stable to compare.

Every draft is `edited ?? server`, where `null` means untouched, so a successful
save needs no resynchronisation and there is no effect writing state. Identity
changes reset the draft during render, which is React's documented pattern and
what the project's `react-hooks` v7 config requires — it rejects synchronous
`setState` in an effect outright.

### The thing that makes it usable

`ApiError` now carries `details[]`. The backend's validators are
accumulator-style and report every fault at once, while `message` is always the
generic *"The request body is invalid."* Without this, a rejected BIN reads as
"invalid" instead of ``BIN '512345' is not valid for network 'visa'.``, and the
BIN editor is guesswork.

Two more traps the screens have to respect: card lists always pass
`includeUnselectable=true`, or the 67 seeded cards with no prefixes are invisible
to the tool that exists to give them some; and both the networks editor and the
scores editor post their complete set, because both endpoints replace.

Access states are honest — a signed-in non-admin gets "No access", not a fake
404. The route table ships in the public bundle, so obscurity buys nothing and
costs a mis-provisioned admin real confusion. Signing in uses Clerk's modal
rather than `#/login`, which redirects a signed-in user into the consumer verify
flow.

## Testing

| File | Cases |
|---|---|
| `adminIdentity.test.ts` | allowlist grants on first sign-in; a non-listed address does not; case and whitespace; **an existing row is granted from a token with no `email` claim**; never revokes; a client cannot claim `isAdmin` |
| `adminAuth.test.ts` | admin session writes; non-admin 403; admin-only *reads* too; unverifiable JWT 401; expired session 401 not 403; the shared token still works on the same route |
| `cardNetworksRead.test.ts` | networks and prefixes both sorted; a bin-less network is `[]` not absent; a card on no networks; round-trips a PATCH; admin session and shared token; 401/403/404; prefixes still absent from the public card |
| `auth.test.ts` | **unchanged** — the check on the shape discriminator |

The frontend has no test harness, no runner and no CI step beyond
`tsc -b && vite build`. Adding one is a project-shaping decision that should not
ride along with a feature, so this is verified by typecheck, lint, build and a
walkthrough. Noted honestly: `frontend/tsconfig.app.json` does not set `strict`,
so `tsc -b` is a weaker net than it looks. If a harness is ever wanted,
`parseHash`/`hrefFor` round-tripping is the highest-value first file — pure, no
DOM.

## Out of scope

- Users and wallets in the console. There is still no endpoint that returns
  anyone else's row, and not building one means no per-user authorisation to get
  wrong.
- An audit trail. Nothing records who changed a card, and the shared-token path
  could not anyway.
- Hard deletes. Everything retires by `is_active = 0`.
- Pagination. Lists request the API's 100 cap and say so when there is more.
- Card art for a newly created bank, which stays generic until an SVG is added.
