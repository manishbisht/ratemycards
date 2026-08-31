# Networks as data, BINs as an admin surface

Design, 2026-08-31.

## Why

Today's structure — added in the uncommitted migrations `0009`–`0011` — already
models banks issuing cards, cards running on many networks, and BIN prefixes
hanging off each `(card, network)` pair. Four things it does not do:

1. A network is a `CHECK` enum of eight values. An admin cannot add one.
2. Nothing distinguishes a credit card from a debit or charge card.
3. BINs are seed-only. There is no endpoint that writes them.
4. A card with no BINs is fully selectable, though nothing can verify it.

An admin panel is coming. It needs banks, networks and cards to all be data it
can edit, and it needs BINs to be writable in the same call that creates a card.

## Shape

```
banks ──issues──▶ cards ──issued on──▶ card_networks ──▶ networks
                    │                       │              │
                    │                       ▼              ▼
                    │                   card_bins    network_bin_rules
                    │
users ──holds──▶ wallet_cards ──proven by──▶ card_verifications
```

`banks` (`0001`), `users` (`0007`), `wallet_cards` (`0008`) and
`card_verifications` (`0011`) are unchanged. `banks` already has admin CRUD at
`/v1/banks` including a soft delete.

## Decisions

| Question | Decision |
|---|---|
| Networks: enum or table? | Table. `code` is the public identifier, `id` internal. |
| Where does BIN-prefix validation live? | `network_bin_rules` rows, enforced in `validate.ts`, not SQL. |
| Does the user pick which network variant they hold? | No. Checkout gets the union of the card's BINs, as today. |
| A card with no BINs | Hidden from discovery. Still resolvable by id. |
| Migration strategy | Rewrite `0009`/`0010` in place; remote has never seen them. |
| Deactivated bank | Its cards leave the catalog. |

## Schema

### `0009_create_card_networks.sql` — rewritten in place

```sql
CREATE TABLE networks (
  id         TEXT    PRIMARY KEY,            -- 'network_1f0c…'
  code       TEXT    NOT NULL,               -- 'visa'
  name       TEXT    NOT NULL,               -- 'Visa'
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (id GLOB 'network_[0-9a-f]*' AND length(id) = 40),
  CHECK (NOT code GLOB '*[^a-z0-9]*' AND length(code) BETWEEN 2 AND 20),
  CHECK (length(trim(name)) BETWEEN 1 AND 40),
  CHECK (is_active IN (0, 1))
);

CREATE UNIQUE INDEX idx_networks_code        ON networks(code);
CREATE INDEX        idx_networks_active_name ON networks(is_active, name);
```

`code` is what the API speaks and what seeds join on; `id` never leaves the
server. Codes are lowercase alphanumeric so they are safe in a URL and stable
as a wire value.

```sql
CREATE TABLE network_bin_rules (
  network_id TEXT NOT NULL REFERENCES networks(id),
  kind       TEXT NOT NULL,                  -- 'glob' | 'range'
  value      TEXT NOT NULL,                  -- '4*'   | '2221-2720'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (network_id, kind, value),
  CHECK (kind IN ('glob', 'range')),
  -- A glob may contain only digits, '[', ']', '-' and '*'. This is what makes
  -- translating it to a RegExp in validate.ts safe: no metacharacter survives.
  -- Verified against every glob 0009's old CHECK used, and against '4|5*',
  -- '4^5*', '4$*', '4+*', '4.*', '4\d*', '4(a)*' and '4 *', all rejected.
  CHECK (kind = 'range' OR NOT value GLOB '*[^]0-9[*-]*'),
  -- A range is 4-digit inclusive bounds compared against the prefix's first
  -- four digits -- the one form 0009's CHECK needed beyond globs.
  CHECK (kind = 'glob'  OR value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]')
);
```

This replaces the 12-line ISO/IEC 7812 `CHECK` in `0009`. That constraint's
stated goal was the rule living in one place no write path can bypass; once
networks are rows a `CHECK` cannot reach them, so the rule moves to
`validate.ts`. The two write paths are the admin API, which validates, and seed
migrations, which we author.

```sql
CREATE TABLE card_networks (
  card_id    TEXT NOT NULL REFERENCES cards(id),
  network_id TEXT NOT NULL REFERENCES networks(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (card_id, network_id)
);

CREATE INDEX idx_card_networks_network_id ON card_networks(network_id);

CREATE TABLE card_bins (
  card_id    TEXT NOT NULL,
  network_id TEXT NOT NULL,
  bin_prefix TEXT NOT NULL,                  -- 6 or 8 digits
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (card_id, bin_prefix),
  FOREIGN KEY (card_id, network_id) REFERENCES card_networks(card_id, network_id),
  CHECK (length(bin_prefix) IN (6, 8)),
  CHECK (NOT bin_prefix GLOB '*[^0-9]*')
);

CREATE INDEX idx_card_bins_prefix ON card_bins(bin_prefix);
```

Preserved from `0009` on purpose: the composite foreign key, so a BIN still
cannot claim a network the card is not issued on; no `UNIQUE` on `bin_prefix`,
because a 6-digit BIN identifies a product family and two cards may share one;
no `ON DELETE CASCADE`.

`PRIMARY KEY (card_id, bin_prefix)` rather than including `network_id`: within
one card a prefix belongs to exactly one network.

### `0010_seed_card_networks.sql` — reseeded

Mints the eight networks, their rules, then the same `(bank name, card name)`
joins it uses today, resolving `network_id` through `networks.code`.

Ids follow `0005`: `'network_' || lower(hex(randomblob(16)))`.

Rules transcribed from `0009`'s old `CHECK`, unchanged in meaning:

| code | rules |
|---|---|
| `visa` | glob `4*` |
| `mastercard` | glob `5[1-5]*`, range `2221-2720` |
| `amex` | glob `3[47]*` |
| `diners` | glob `3[68]*`, glob `30[0-5]*` |
| `rupay` | glob `6[05]*`, glob `8[12]*`, glob `508*` |
| `discover` | glob `6011*`, glob `64[4-9]*`, glob `65*` |
| `jcb` | range `3528-3589` |
| `unionpay` | glob `62*`, glob `81*` |

The BIN prefix data itself is unchanged: the same 99 real prefixes across the
same 33 cards, from `github.com/venelinkochev/bin-list-data`. The
`0010` header comments about provenance and about what a BIN actually proves
carry over verbatim; only the enum-vs-table mechanics change.

### `0012_add_card_type.sql` — new

```sql
ALTER TABLE cards ADD COLUMN type TEXT NOT NULL DEFAULT 'credit'
  CHECK (type IN ('credit', 'debit', 'charge', 'prepaid'));
```

SQLite does enforce a `CHECK` added this way — verified before writing this. So
the enum is DB-enforced even though `0002` is immutable and `ALTER TABLE` cannot
add a constraint to an existing column.

Every seeded card is credit, and credit is the default, so no read path filters
on `type` yet. No `?type=` filter until something needs one.

## BIN-gated visibility

A card with no BIN rows is not selectable. The rule is **discovery-scoped, not
resolution-scoped**, because a blanket filter on `listCards` would take cards
out of wallets that already hold them:

- `wallet/queries.ts:45` resolves a user's holdings *through* `listCards({ ids })`.
  A gated-out card would drop from their wallet and change their score.
- `frontend/src/store/store.ts:70-77` dispatches `walletActions.pruneCards(visibleIds)`
  on `loadCatalog.fulfilled`. A catalog shrinking from 100 to 33 would actively
  prune 67 cards from every existing user's persisted wallet.

| Request | Gated |
|---|---|
| `GET /v1/cards` — browse, search | yes |
| `GET /v1/cards?ids=…` — resolve holdings | no |
| `GET /v1/cards/:id` | no |
| `GET /v1/cards?includeUnselectable=true` | no |
| `resolveWallet`, `POST /v1/wallet/preview` | no |

`includeUnselectable` needs no auth. It exposes no secret: card names are public
and BIN prefixes are still never serialised onto a card.

In `buildWhere`, gated means:

```sql
EXISTS (SELECT 1 FROM card_bins cb WHERE cb.card_id = c.id)
```

applied only when `filters.ids` is absent and `includeUnselectable` is false.

**Consequence, accepted:** the picker shows **33 cards, not 100**, until an admin
backfills BINs for the rest. Wallets that already hold the other 67 keep them,
keep their verification status, and keep scoring.

## Deactivated banks

`buildWhere` filters `c.is_active = 1` but `FROM_CARDS` joins `banks` with no
condition, so removing a bank leaves its cards in the catalog. Add
`b.is_active = 1` under the same `includeInactive` flag. Held cards still
resolve, by the same `ids` carve-out as the BIN gate.

## API

### `/v1/networks` — new, mirroring `/v1/banks`

```
GET    /v1/networks            public   { data: [{ id, code, name, isActive, binRules }], total }
GET    /v1/networks/:id        public
POST   /v1/networks            admin    { code, name, binRules, isActive? }
PATCH  /v1/networks/:id        admin    partial; binRules replaces
DELETE /v1/networks/:id        admin    soft delete (is_active = 0)
```

`binRules` is `[{ kind: 'glob' | 'range', value: string }]`. On `PATCH` it
replaces the whole rule set rather than merging, matching
`PUT /v1/cards/:id/scores`; omitting it leaves the rules untouched, and `[]`
clears them — which makes the network unusable for new BINs until rules return.

`POST` requires at least one rule. Rules are public: they are the ISO/IEC 7812
prefix table, not card data. `4*` tells an attacker nothing a Visa card does not
already tell them, and actual prefixes are still never published.

A soft-deleted network keeps its existing `card_networks` rows and keeps working
as a `?network=` filter value. What changes is that card writes reject it. An
inactive network does not affect card visibility — the BIN gate is the only
visibility rule being added.

### `/v1/cards` — changed

Networks and BINs are written together, so one call creates a card completely:

```jsonc
POST /v1/cards
{
  "bankId": "bank_…",
  "name": "Infinia",
  "country": "IN",
  "type": "credit",              // optional, defaults to 'credit'
  "joiningFee": 12500,
  "annualFee": 12500,
  "networks": [
    { "code": "visa",       "bins": ["412345", "45678901"] },
    { "code": "mastercard", "bins": ["521234"] }
  ]
}
```

- **Breaking:** `networks: ["visa", "rupay"]` is replaced by the object form, not
  extended. The only consumers are our own seeds and the future admin panel.
- `networks` replaces the whole network *and* BIN set. Omitting it leaves both
  untouched. `bins` may be `[]` or absent, which means the card is on that
  network with no prefixes on file — and therefore not selectable.
- `networks: []` is accepted and means "on no networks": it clears both tables
  for the card, leaving it unselectable and unverifiable. This relaxes today's
  "callers are validated to pass at least one network", because an admin editing
  a card they got wrong needs a way back to empty.
- `type` is patchable, and validated against the same four values as the `CHECK`.
- **Removed:** the 409 *"cannot remove a network while BIN prefixes are still on
  file"*. The caller now states networks and BINs in one breath, so replacing
  legitimately drops both. `replaceNetworks` deletes a dropped network's BINs
  before the network row.
- `?network=visa` still takes a code. Resolution to `network_id` is internal.
- `?includeUnselectable=true` is new.
- `GET /v1/cards` still does not serialise networks or BINs. Unchanged, and for
  the reason `README.md:247` gives.

## Validation

`validate.ts` stays pure and synchronous, so `validate.test.ts` remains a unit
test. `validateCardInput(body)` becomes `validateCardInput(body, networks)`;
`routes.ts` loads the active networks with their rules and passes them in.

Rule matching, given a prefix and its network's rules — a prefix is valid if
**any** rule matches:

- **glob** — translated to a `RegExp` anchored at both ends: `*` becomes `.*`,
  a `[…]` class passes through, digits are literal. Safe because the DB `CHECK`
  admits no other characters. Anchoring means a rule must end in `*` to match a
  longer prefix; `508` alone matches nothing 6 digits long.
- **range** — `parseInt(prefix.slice(0, 4), 10)` within `lo..hi` inclusive.

Rejections, each a 422 with a specific message:

| Case | Message shape |
|---|---|
| Unknown `code` | `'xyz' is not a known network.` |
| Inactive network | `Network 'xyz' is not active.` |
| Network has no rules | `Network 'xyz' has no BIN rules on file; add them first.` |
| Prefix fails every rule | `BIN '512345' is not valid for network 'visa'.` |
| Prefix not 6 or 8 digits | `BIN '1234' must be 6 or 8 digits.` |
| Duplicate code in `networks` | `Network 'visa' is listed twice.` |
| Same prefix under two networks | `BIN '412345' is listed under more than one network.` |

A network with no rules rejects rather than accepting anything: it cannot
validate, and silently waving BINs through would defeat the point.

## Frontend

No visible change. The picker filters a catalog it already loads whole; it
simply receives fewer cards. No component, selector or slice changes.

`store.ts`'s prune listener is left alone — the `ids` carve-out means the
catalog no longer shrinks under a wallet, so the listener stays correct.

## Testing

| File | Cases |
|---|---|
| `validate.test.ts` | glob match and miss; 4-digit range at both bounds and outside; 6 vs 8 digits; non-digits; unknown code; inactive network; ruleless network; duplicate code; one prefix under two networks |
| `cardsWrite.test.ts` | create with nested networks + bins; replace drops a network *and* its bins; replace with `bins: []` leaves the card unselectable; `type` defaults to `credit`; invalid `type` is a 422; unknown network code is a 422 |
| `cardsRead.test.ts` | BIN-less card absent from `GET /v1/cards`; present via `?ids=`; present via `GET /v1/cards/:id`; present via `?includeUnselectable=true`; `?network=visa` still filters; deactivated bank hides its cards but `?includeInactive=true` shows them |
| `walletPersistence.test.ts` | a wallet holding a BIN-less card resolves, scores, and keeps its verification status |
| `verification.test.ts` | existing behaviour holds through the `network_id` change; a card with networks but no BINs still fails to start a verification |
| new `networks.test.ts` | CRUD; `binRules` replaces; soft delete keeps `?network=` working; writes reject an inactive network |

## Sequence

1. Rewrite `0009`; reseed `0010`; add `0012`.
2. Wipe local D1 and re-apply. **This destroys local dev users and wallets** —
   the cost of the in-place rewrite. Remote has never had `0009`–`0011`.
3. Backend: new `modules/networks/`; `cards/{cardTypes,validate,queries,routes}.ts`
   for the nested shape, `network_id`, the BIN gate, `b.is_active = 1`;
   `verification/routes.ts` for id-based lookups.
4. Tests per the table above.
5. `README.md`: the "Networks and BINs" section at `:239`, its "BINs are
   seed-only" claim at `:267`, and the `0009`-referencing prose around it.

## Out of scope

- The admin panel itself. This makes the API it will need.
- Widening `0010`'s BIN coverage past 33 cards.
- Recording which network variant a holder actually has.
- Enforcing `issuer` in verification. Razorpay reports 4-character bank codes
  (`UTIB` for Axis) and the mapping table does not exist.
- A `?type=` filter on the catalog.
