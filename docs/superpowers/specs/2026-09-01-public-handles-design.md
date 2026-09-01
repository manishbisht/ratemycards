# A handle somebody else can open

Design, 2026-09-01.

## Why

The claim screen works and claims nothing. `walletActions.claimHandle` writes a
string into Redux, `localStorage` persists it, and availability is checked
against `TAKEN_HANDLES` — five names transcribed from the design
(`data/handles.ts:2`). Two people on two phones can both "claim" `arjun`, and
neither claim survives clearing a browser.

The profile behind it is the same shape of placeholder. `#/u/<handle>` renders
your own wallet when the handle matches the one in your Redux state, and
otherwise falls back to `demoProfile.ts` — one hardcoded wallet under `arjun`,
whose docstring says it stands in "until public profiles are a real endpoint."

This makes both real: a handle is a row nobody else can take, and the profile is
an endpoint anyone can open with no session at all.

## Decisions

| Question | Decision |
|---|---|
| What does a public profile expose? | Handle, score, tier, verified count, and the verified cards' names. Not email, name, avatar, user id, or unverified picks. |
| Can a handle change? | Yes, and the old one returns to the pool. |
| Where does the handle live? | A `UNIQUE` column on `users`, not a table of its own. |
| Who owns the public read? | A new `profiles` module. Not `users`, whose whole point is that it never returns anyone else's row. |
| What makes it unique? | The unique index. Not a read-then-write. |
| Can you claim before verifying a card? | No, and the server is what says so. |

### The consequence of freeing a handle

A link shared as `#/u/arjun` can later resolve to a different person, because
`arjun` goes back in the pool when its owner renames. That is a deliberate
choice, taken with the alternative on the table: retiring released handles costs
a second table and a second lookup on every claim, and the kindness to somebody
who mistyped their own name was judged worth more than the impersonation risk on
a page that publishes no more than a score and a list of card products.

Worth revisiting if profiles ever carry anything that could be used to
impersonate rather than merely admire.

## Schema

### `0014_add_user_handle.sql`

```sql
ALTER TABLE users ADD COLUMN handle TEXT
  CHECK (handle IS NULL OR (NOT handle GLOB '*[^a-z0-9_]*' AND length(handle) BETWEEN 3 AND 20));

CREATE UNIQUE INDEX idx_users_handle ON users(handle);
```

A column rather than a table: the relationship is one-to-one, nothing hangs off
a handle, and no history is kept.

SQLite's unique index permits any number of `NULL`s, so the great majority of
rows — everyone who has not claimed — cost nothing and collide with nothing.

The `CHECK` mirrors `HANDLE_PATTERN` in `data/handles.ts:8`, per the convention
in `src/http/validators.ts:10-13`: the validator exists to produce a good 400,
the constraint is the backstop no write path can bypass. Change one, change the
other.

**The index is the uniqueness guarantee.** Two claims for `arjun` in the same
instant both pass any `SELECT`-then-`UPDATE` check and one silently overwrites
the other; against the index, one `UPDATE` wins and the other raises `UNIQUE
constraint failed`, which `isUniqueViolation` turns into a 409. That helper is
already written three times over — `banks/queries.ts:126`,
`networks/queries.ts:231`, `scoring/queries.ts:220` — and this follows the
house pattern rather than refactoring it.

## API

```
PUT  /v1/users/me/handle    session   { handle }  -> the caller's user row
GET  /v1/handles/:handle    public                -> { handle, available }
GET  /v1/profiles/:handle   public                -> the public profile
```

`PUT` rather than `POST`: there is one handle per user, re-sending the same one
is a no-op, and changing it frees the previous value as a side effect of it
being a single column.

`GET /v1/users/me` gains `handle`, which is what lets a second device recover it.

### Claiming requires a verified card

`ClaimHandlePage.tsx:24-32` already refuses to render without one, and states
why: "so a public profile never exists with nothing verified behind it." A rule
enforced only in the client is not enforced, so the route checks it too — 409
with a message pointing at verification.

The users module cannot read `wallet_cards` (`backend/README.md:26`), so this is
a call into `wallet`, the way `cards/routes.ts` calls
`networks.listNetworksForValidation`.

### Reserved handles

`admin`, `api`, `www`, `u`, `health` are refused with a 400 — the validator catches
them before any database work, so it is a bad value rather than a conflict.
There is no routing
collision to avoid — profiles live under `#/u/`, so `admin` as a handle would
resolve fine — the point is that `@admin` on a page about somebody's money reads
as authority nobody granted. One array in `validate.ts`.

### Errors

| Case | Response |
|---|---|
| Not signed in | 401 |
| No verified card | 409, naming verification |
| Malformed handle on claim | 400, with `details` from the accumulator validator |
| Reserved handle on claim | 400, with `details` naming it as reserved |
| Already taken | 409 |
| `GET /v1/handles/:handle`, unclaimed | `{ available: true }` |
| `GET /v1/handles/:handle`, taken **or reserved** | `{ available: false }` |
| `GET /v1/handles/:handle`, malformed | `{ available: false }`, not a 400 |

The availability endpoint answers one question — "would claiming this succeed?"
— so reserved and malformed handles are both `false` rather than a 409 and a
400. Anything else and the screen shows a tick over a handle the claim will
reject. The claim route still returns the specific status and message; this one
only ever feeds an icon.
| `GET /v1/profiles/:handle`, no such handle | 404 |
| `GET /v1/profiles/:handle`, owner deactivated | 404 |

An availability endpoint enumerates which handles exist, which is not a leak the
profile endpoint does not already have: a 200 from `/v1/profiles/:handle` says
the same thing. It exists because it is cheap — one indexed lookup against a
profile read that resolves and scores a whole wallet.

## The profile

`getWallet` scores the entire wallet, but a profile shows verified cards only —
which is already what the frontend does (`ProfilePage.tsx:37` scores
`verifiedCards`). So `wallet/queries.ts` gains `getVerifiedWallet(db, userId)`,
a filtered twin of `getWallet`: verified rows, then `listCards`, then
`scoreWallet` over exactly those ids. Retired and BIN-less cards resolve the
same way they do there, for the same reason — somebody holding a card the
catalog dropped should not quietly lose the points.

`modules/profiles/` composes and projects, and writes no SQL of its own:

```
GET /v1/profiles/:handle
  users.getUserByHandle(handle)   -> 404 if absent or inactive
  wallet.getVerifiedWallet(id)
  -> { handle, score, maxScore, tier, cardCount, cards: [{ id, name, issuer, bank }] }
```

The projection is the security boundary and is written as one function, so what
is public is one thing to read and one thing to review. `summaryFor` stays on
the client: it is presentation derived from score and count, and the server has
no opinion about it.

## Frontend

`checkHandle` drops `TAKEN_HANDLES` and becomes shape-only — length, alphabet,
normalisation. Availability becomes a debounced call to `/v1/handles/:handle`,
which keeps the live ✓/✕ the screen is built around. `debounce` is inline, as in
`state/useWalletScore.ts:25-53`; the shared hook was deleted in `8d8922c` for
want of a second caller and is not worth resurrecting for one.

Claiming calls the API and renders a 409 next to the field instead of
navigating, because between the availability check and the claim someone else
can take it — the window is small and the failure has to be visible.

`ProfilePage` fetches a real profile for any handle that is not yours, so
**`demoProfile.ts` is deleted** and `#/u/arjun` 404s until somebody claims it.
Your own profile keeps rendering from local state, so it stays instant and
correct while a claim is still in flight.

`useClerkUserSync` hydrates `handle` from `/v1/users/me`. Without it the handle
lives only in one browser's `localStorage`, and signing in anywhere else looks
like you never claimed one.

## Testing

| File | Cases |
|---|---|
| new `handles.test.ts` | claim; the same handle twice from two users is a 409; renaming frees the old one for somebody else; no verified card is a 409; reserved words are a 409; malformed handles are a 400 with details; case is normalised; `/v1/users/me` returns it |
| new `profiles.test.ts` | a signed-out read works; only verified cards appear; score matches the verified set, not the whole wallet; 404 on unknown; 404 once the owner is deactivated; the payload contains no email, name, image or user id |
| `usersWebhook.test.ts` | a webhook upsert leaves an existing handle alone |

Per-file storage isolation means both new files mint their own users and cards.
The frontend has no harness — typecheck, lint, build, and a walkthrough.

## Out of scope

- Retiring released handles, and any history of who held what.
- Reserving a handle before verifying, or holding one temporarily.
- Editing a handle from anywhere but the claim screen.
- Rate limiting the public endpoints. They are cheap and read-only, and nothing
  else in the API is rate limited yet either — worth doing as its own piece of
  work across all of it rather than here.
- Profile metadata: avatars, bios, display names. A profile is a score and a
  deck.
