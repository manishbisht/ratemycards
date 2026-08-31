# Networks as Data, BINs as an Admin Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the eight-value network `CHECK` enum into a `networks` table with per-network BIN prefix rules, make BINs writable alongside a card, add `cards.type`, and hide cards that have no BINs from discovery.

**Architecture:** `0009` and `0010` are uncommitted and have never been applied to remote D1, so they are rewritten in place rather than patched forward. Network *codes* (`'visa'`) stay the public wire value; `network_id` is internal, resolved by join. BIN-prefix validation moves out of SQL — a `CHECK` cannot reach a table — into a pure matcher plus `validate.ts`. The BIN visibility gate is discovery-scoped: an explicit `ids=` lookup is exempt, because four call sites resolve wallets through `listCards({ ids })` and gating them would take cards out of wallets people already hold.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), TypeScript, vitest via `@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-08-31-cards-networks-bins-design.md`

## Global Constraints

- Public ids are `<prefix>_` + 32 lowercase hex. `ID_LENGTH(prefix) = prefix.length + 1 + 32`. Network ids use prefix `network`, so `length(id) = 40`.
- Validators in `validate.ts` exist to produce a good 400; the migration `CHECK` constraints are the backstop no write path can bypass. Change one, change the other. (`src/http/validators.ts` header.)
- Validation is accumulator-style: collect every problem, report them together.
- Sets are **replaced, not merged**, matching `PUT /v1/cards/:id/scores`.
- An applied migration is immutable. `0009`/`0010` are exempt *only* because remote has never had them; `0001`–`0008` and `0011` are not to be touched.
- `GET /v1/cards` never serialises networks or BINs, for the reason in `backend/README.md:247`.
- Network **codes** cross the API boundary. `network_id` never leaves the server.
- Every mutation route carries `adminAuth`. The count of `adminAuth` in a routes file must equal its number of write handlers.
- Test files have per-file storage isolation; writes belong in `cardsWrite.test.ts`-style files so they do not leak into counts asserted elsewhere.
- Run `npm test` from `backend/`. Full suite must be green at the end of every task.

---

### Task 1: Networks and rules as tables, seeded

Rewrites `0009` to its final shape and reseeds `0010`. `cards/queries.ts` is adapted just enough that codes still go in and out unchanged, so the external API is byte-identical and the suite stays green. Adds the `cards.type` column (wired to the API in Task 7).

**Files:**
- Modify: `backend/migrations/0009_create_card_networks.sql` (full rewrite)
- Modify: `backend/migrations/0010_seed_card_networks.sql:41-42,159-161,167-168,270-272`
- Create: `backend/migrations/0012_add_card_type.sql`
- Modify: `backend/src/modules/cards/queries.ts:131-135,205-228,243-264`
- Modify: `backend/test/cardsWrite.test.ts:227-234,317-325`
- Create: `backend/test/networks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `networks(id, code, name, is_active, created_at, updated_at)`, `network_bin_rules(network_id, kind, value, created_at)`, `card_networks(card_id, network_id, created_at)`, `card_bins(card_id, network_id, bin_prefix, created_at)`, and column `cards.type`. `listCardNetworks(db, cardId)` keeps its existing signature and still returns `{ network: string; bins: string[] }[]` where `network` is a code.

- [ ] **Step 1: Write the failing seed test**

Create `backend/test/networks.test.ts`:

```ts
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { NETWORK_ID_PATTERN } from '../src/modules/networks/networkTypes'

/**
 * The seed in 0010 is the source of the network list. These assertions are what
 * stops a reseed from silently dropping a network or a prefix rule.
 */
describe('networks seed', () => {
  it('seeds eight networks with well-formed ids', async () => {
    const { results } = await env.DB.prepare(
      'SELECT id, code, name, is_active FROM networks ORDER BY code',
    ).all<{ id: string; code: string; name: string; is_active: number }>()

    expect(results.map((r) => r.code)).toEqual([
      'amex', 'diners', 'discover', 'jcb', 'mastercard', 'rupay', 'unionpay', 'visa',
    ])
    for (const row of results) {
      expect(row.id).toMatch(NETWORK_ID_PATTERN)
      expect(row.is_active).toBe(1)
    }
    expect(results.find((r) => r.code === 'visa')?.name).toBe('Visa')
  })

  it('carries every prefix rule 0009 used to enforce in SQL', async () => {
    const { results } = await env.DB.prepare(
      `SELECT nw.code, r.kind, r.value
       FROM network_bin_rules r
       JOIN networks nw ON nw.id = r.network_id
       ORDER BY nw.code, r.kind, r.value`,
    ).all<{ code: string; kind: string; value: string }>()

    expect(results.map((r) => `${r.code}:${r.kind}:${r.value}`)).toEqual([
      'amex:glob:3[47]*',
      'diners:glob:30[0-5]*',
      'diners:glob:3[68]*',
      'discover:glob:6011*',
      'discover:glob:64[4-9]*',
      'discover:glob:65*',
      'jcb:range:3528-3589',
      'mastercard:glob:5[1-5]*',
      'mastercard:range:2221-2720',
      'rupay:glob:508*',
      'rupay:glob:6[05]*',
      'rupay:glob:8[12]*',
      'unionpay:glob:62*',
      'unionpay:glob:81*',
      'visa:glob:4*',
    ])
  })

  it('links every seeded card_networks row to a real network', async () => {
    const orphans = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM card_networks cn
       LEFT JOIN networks nw ON nw.id = cn.network_id
       WHERE nw.id IS NULL`,
    ).first<{ n: number }>()
    expect(orphans?.n).toBe(0)

    const pairs = await env.DB.prepare('SELECT COUNT(*) AS n FROM card_networks').first<{ n: number }>()
    expect(pairs?.n).toBe(114)
  })

  it('keeps all 99 seeded BIN prefixes across 33 cards', async () => {
    const bins = await env.DB.prepare('SELECT COUNT(*) AS n FROM card_bins').first<{ n: number }>()
    expect(bins?.n).toBe(99)

    const carded = await env.DB.prepare(
      'SELECT COUNT(DISTINCT card_id) AS n FROM card_bins',
    ).first<{ n: number }>()
    expect(carded?.n).toBe(33)
  })

  it('defaults every seeded card to type credit', async () => {
    const other = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cards WHERE type <> 'credit'",
    ).first<{ n: number }>()
    expect(other?.n).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/networks.test.ts`
Expected: FAIL — `networkTypes` module does not exist, and `no such table: networks`.

- [ ] **Step 3: Create the network id helpers the test imports**

Create `backend/src/modules/networks/networkTypes.ts`:

```ts
import { generateId, idPattern } from '../../http/ids'

export const NETWORK_ID_PREFIX = 'network'
export const NETWORK_ID_PATTERN = idPattern(NETWORK_ID_PREFIX)

export function generateNetworkId(): string {
  return generateId(NETWORK_ID_PREFIX)
}
```

- [ ] **Step 4: Rewrite migration 0009**

Replace the whole of `backend/migrations/0009_create_card_networks.sql`:

```sql
-- Migration number: 0009 	 2026-08-30T00:00:00.000Z
-- The networks module: the payment networks a card can be issued on, the BIN
-- prefix rules each network allocates under, and which of those a given card
-- actually runs on.
--
-- This is the migration 0002 promised ("Networks ... arrive in a later
-- migration"). 0002 is applied and therefore immutable, so its stale comment is
-- left alone.
--
-- WHY A CARD HAS A PARTICULAR BIN
-- The leading digits of a card number are the IIN (Issuer Identification
-- Number), universally called the BIN -- ISO/IEC 7812, historically 6 digits,
-- officially 8 since 2022. It is allocated in three nested layers:
--
--   1. Digit 1 is the Major Industry Identifier, which is why every Visa
--      starts 4, every Amex 34 or 37, and so on.
--   2. Digits 1-8 are the block the network allocated to one issuer. HDFC's
--      Visa credit block is not ICICI's.
--   3. Within its block the issuer sub-allocates ranges per product: funding
--      type, consumer vs commercial, and tier.
--
-- At authorization the acquirer sees only the card number, so the BIN is what
-- tells it which network to route to and which issuer to ask.
--
-- TWO ASYMMETRIES WORTH KNOWING BEFORE BUILDING ON THIS
-- A 6-digit BIN usually identifies issuer + network + product *family*, not one
-- product, so two cards may legitimately share a prefix: BIN -> card is
-- many-to-many, and there is deliberately no UNIQUE on bin_prefix.
-- And prefix -> network is ambiguous in the other direction (65 is both RuPay
-- and Discover; 81 both RuPay and UnionPay), which is why a card's network is
-- stored rather than derived. Only network -> allowed prefixes is a function,
-- and that is the direction network_bin_rules expresses.
--
-- WHY THE PREFIX RULES ARE ROWS AND NOT A CHECK
-- An earlier draft of this migration held the whole ISO/IEC 7812 prefix table
-- in one CHECK on card_bins, so no write path could bypass it. That stops
-- working the moment networks become rows an admin can add: a CHECK cannot
-- subquery a table. The rules therefore live in network_bin_rules and are
-- enforced by modules/networks/binRules.ts, reached from cards/validate.ts.
-- What stays in SQL is everything that does not need the lookup.

CREATE TABLE networks (
  id         TEXT    PRIMARY KEY,            -- 'network_1f0c...', server-generated
  code       TEXT    NOT NULL,               -- 'visa' -- the value the API speaks
  name       TEXT    NOT NULL,               -- 'Visa'
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (id GLOB 'network_[0-9a-f]*' AND length(id) = 40),
  -- Lowercase alphanumeric, so a code is safe in a query string and stable as a
  -- wire value.
  CHECK (NOT code GLOB '*[^a-z0-9]*' AND length(code) BETWEEN 2 AND 20),
  CHECK (length(trim(name)) BETWEEN 1 AND 40),
  CHECK (is_active IN (0, 1))
);

-- Ids are random and carry no meaning, so the code is what identifies a network.
CREATE UNIQUE INDEX idx_networks_code        ON networks(code);
CREATE INDEX        idx_networks_active_name ON networks(is_active, name);

CREATE TABLE network_bin_rules (
  network_id TEXT NOT NULL REFERENCES networks(id),
  kind       TEXT NOT NULL,                  -- 'glob' | 'range'
  value      TEXT NOT NULL,                  -- '4*'   | '2221-2720'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- A row IS the rule; there is nothing else to address it by.
  PRIMARY KEY (network_id, kind, value),
  CHECK (kind IN ('glob', 'range')),
  -- A glob may contain only digits, '[', ']', '-' and '*'. This constraint is
  -- what makes translating it straight to a RegExp in binRules.ts safe: no
  -- regex metacharacter survives it. Verified against every glob this
  -- migration's predecessor used, and against '4|5*', '4^5*', '4$*', '4+*',
  -- '4.*', '4\d*', '4(a)*' and '4 *', all rejected.
  CHECK (kind = 'range' OR NOT value GLOB '*[^]0-9[*-]*'),
  -- A range is 4-digit inclusive bounds compared against the prefix's first
  -- four digits -- the one form globs could not express (Mastercard's
  -- 2221-2720, JCB's 3528-3589).
  CHECK (kind = 'glob'  OR value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]')
);

CREATE TABLE card_networks (
  card_id    TEXT NOT NULL REFERENCES cards(id),
  network_id TEXT NOT NULL REFERENCES networks(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- A row IS the (card, network) pair, matching card_scores and wallet_cards.
  PRIMARY KEY (card_id, network_id)
);

-- Answers "which cards run on Visa", which the ?network= filter asks. The other
-- direction is already covered by the primary key.
CREATE INDEX idx_card_networks_network_id ON card_networks(network_id);

CREATE TABLE card_bins (
  card_id    TEXT NOT NULL,
  network_id TEXT NOT NULL,
  -- 6 or 8 digits. 6 is the historical IIN width and still what most public
  -- sources publish; 8 is the current ISO/IEC 7812 width.
  bin_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- One row per prefix per card: within a single card a prefix belongs to
  -- exactly one network. Two *different* cards may share a prefix, because a
  -- 6-digit BIN often identifies a product family rather than a product -- so
  -- this is not UNIQUE(bin_prefix), on purpose.
  PRIMARY KEY (card_id, bin_prefix),
  -- A BIN cannot claim a network the card does not run on. The parent is
  -- card_networks' primary key, so this needs no extra index. No ON DELETE
  -- CASCADE: as with banks in 0002, dropping a network out from under its BINs
  -- should fail loudly rather than silently destroy them. The card write path
  -- deletes BINs before their network row, in that order, deliberately.
  FOREIGN KEY (card_id, network_id) REFERENCES card_networks(card_id, network_id),
  CHECK (length(bin_prefix) IN (6, 8)),
  CHECK (NOT bin_prefix GLOB '*[^0-9]*')
);

-- For the "these digits -> which cards" lookup, which searches by prefix across
-- every card rather than within one.
CREATE INDEX idx_card_bins_prefix ON card_bins(bin_prefix);
```

- [ ] **Step 5: Seed networks and rules at the head of migration 0010**

In `backend/migrations/0010_seed_card_networks.sql`, insert immediately before the existing `INSERT INTO card_networks` at line 41:

```sql
-- The networks themselves, and the ISO/IEC 7812 prefix rules each allocates
-- under. Transcribed unchanged in meaning from the single CHECK an earlier
-- draft of 0009 carried; see the note there on why they are rows now.
--
-- Ids are minted here the same way 0005 mints bank and card ids: they differ in
-- every database, so everything below joins on `code` instead.
INSERT INTO networks (id, code, name)
WITH n(code, name) AS (
  VALUES
    ('visa'      , 'Visa'),
    ('mastercard', 'Mastercard'),
    ('amex'      , 'American Express'),
    ('diners'    , 'Diners Club'),
    ('rupay'     , 'RuPay'),
    -- The last three do not occur in an 'IN' catalog. They are seeded anyway
    -- because they cost a row each and an admin should not have to invent the
    -- ISO prefix rules for a network the standard already fixed.
    ('discover'  , 'Discover'),
    ('jcb'       , 'JCB'),
    ('unionpay'  , 'UnionPay')
)
SELECT 'network_' || lower(hex(randomblob(16))), code, name FROM n;

INSERT INTO network_bin_rules (network_id, kind, value)
WITH r(code, kind, value) AS (
  VALUES
    ('visa'      , 'glob' , '4*'),
    ('mastercard', 'glob' , '5[1-5]*'),
    ('mastercard', 'range', '2221-2720'),
    ('amex'      , 'glob' , '3[47]*'),
    ('diners'    , 'glob' , '3[68]*'),
    ('diners'    , 'glob' , '30[0-5]*'),
    ('rupay'     , 'glob' , '6[05]*'),
    ('rupay'     , 'glob' , '8[12]*'),
    ('rupay'     , 'glob' , '508*'),
    ('discover'  , 'glob' , '6011*'),
    ('discover'  , 'glob' , '64[4-9]*'),
    ('discover'  , 'glob' , '65*'),
    ('jcb'       , 'range', '3528-3589'),
    ('unionpay'  , 'glob' , '62*'),
    ('unionpay'  , 'glob' , '81*')
)
SELECT nw.id, r.kind, r.value
FROM r
JOIN networks nw ON nw.code = r.code;
```

- [ ] **Step 6: Point 0010's two card inserts at network ids**

Change line 41 of `backend/migrations/0010_seed_card_networks.sql` from:

```sql
INSERT INTO card_networks (card_id, network)
```

to:

```sql
INSERT INTO card_networks (card_id, network_id)
```

Change its `SELECT` at lines 159-161 from:

```sql
SELECT c.id, n.network
FROM nets n
JOIN banks b ON b.name = n.bank
```

to:

```sql
SELECT c.id, nw.id
FROM nets n
JOIN networks nw ON nw.code = n.network
JOIN banks b ON b.name = n.bank
```

Change line 167 from `INSERT INTO card_bins (card_id, network, bin_prefix)` to `INSERT INTO card_bins (card_id, network_id, bin_prefix)`, and its `SELECT` at lines 270-272 from:

```sql
SELECT c.id, x.network, x.bin_prefix
FROM bins x
JOIN banks b ON b.name = x.bank
```

to:

```sql
SELECT c.id, nw.id, x.bin_prefix
FROM bins x
JOIN networks nw ON nw.code = x.network
JOIN banks b ON b.name = x.bank
```

Leave both `VALUES` blocks and every header comment untouched — the 114 pairs and 99 prefixes are unchanged data.

- [ ] **Step 7: Add migration 0012**

Create `backend/migrations/0012_add_card_type.sql`:

```sql
-- Migration number: 0012 	 2026-08-31T00:00:00.000Z
-- What kind of card this is. Credit for now: it is the whole of the launch
-- catalog and the only kind the scoring rubric was written for.
--
-- ALTER TABLE ADD COLUMN can carry a CHECK, and SQLite enforces it -- unlike
-- adding a constraint to a column that already exists, which needs a full table
-- rebuild. 0002 is applied and immutable, so this is the only way the enum gets
-- to be DB-enforced rather than validator-only.
--
-- The default is what makes this safe on a populated table: every one of the
-- 100 cards seeded by 0005 is a credit card.

ALTER TABLE cards ADD COLUMN type TEXT NOT NULL DEFAULT 'credit'
  CHECK (type IN ('credit', 'debit', 'charge', 'prepaid'));
```

- [ ] **Step 8: Adapt the three queries that read the old `network` column**

In `backend/src/modules/cards/queries.ts`, replace the `f.network` branch of `buildWhere` (lines 131-135):

```ts
  if (f.network) {
    // EXISTS rather than a join: a card on two networks must still count once.
    // The filter takes a code, not an id -- ids never leave the server.
    conds.push(
      `EXISTS (SELECT 1 FROM card_networks cn
               JOIN networks nw ON nw.id = cn.network_id
               WHERE cn.card_id = c.id AND nw.code = ?)`,
    )
    binds.push(f.network)
  }
```

Replace the body of `listCardNetworks` (lines 209-218) so it resolves codes on the way out:

```ts
  const { results } = await db
    .prepare(
      `SELECT nw.code AS network, cb.bin_prefix
       FROM card_networks cn
       JOIN networks nw ON nw.id = cn.network_id
       LEFT JOIN card_bins cb ON cb.card_id = cn.card_id AND cb.network_id = cn.network_id
       WHERE cn.card_id = ?
       ORDER BY nw.code, cb.bin_prefix`,
    )
    .bind(cardId)
    .all<{ network: NetworkCode; bin_prefix: string | null }>()
```

Replace the body of `replaceNetworks` (lines 251-263) so it maps codes to ids in SQL:

```ts
  // `NOT IN ()` is not valid SQL, so an empty set drops the clause rather than
  // emitting it.
  const keep =
    networks.length > 0
      ? `AND network_id NOT IN (SELECT id FROM networks WHERE code IN (${placeholders(networks.length)}))`
      : ''

  await db.batch([
    db.prepare(`DELETE FROM card_networks WHERE card_id = ? ${keep}`).bind(cardId, ...networks),
    // The card may already be on some of these; the pair is the primary key.
    // The SELECT is what turns a code into an id, so an unknown code inserts
    // nothing rather than a bad row -- validate.ts is what reports it.
    ...networks.map((code) =>
      db
        .prepare(
          `INSERT INTO card_networks (card_id, network_id)
           SELECT ?, id FROM networks WHERE code = ? ON CONFLICT DO NOTHING`,
        )
        .bind(cardId, code),
    ),
  ])
```

- [ ] **Step 9: Update the two tests that read the old column**

In `backend/test/cardsWrite.test.ts`, replace the `networksOf` helper (lines 227-234):

```ts
  /** The network codes the table holds for a card, sorted. */
  async function networksOf(cardId: string): Promise<string[]> {
    const { results } = await env.DB.prepare(
      `SELECT nw.code AS network
       FROM card_networks cn
       JOIN networks nw ON nw.id = cn.network_id
       WHERE cn.card_id = ?
       ORDER BY nw.code`,
    )
      .bind(cardId)
      .all()
    return results.map((row: any) => row.network)
  }
```

And in the `refuses to drop a network that still has BIN prefixes` test, replace the raw `card_bins` insert (line 319) with one that resolves the id:

```ts
    await env.DB.prepare(
      `INSERT INTO card_bins (card_id, network_id, bin_prefix)
       SELECT ?, id, ? FROM networks WHERE code = ?`,
    )
      .bind(created.id, '412345', 'visa')
      .run()
```

- [ ] **Step 10: Run the new test and the full suite**

Run: `cd backend && npx vitest run test/networks.test.ts`
Expected: PASS, 5 tests.

Run: `cd backend && npm test`
Expected: PASS. The external API is unchanged, so every pre-existing test still holds.

- [ ] **Step 11: Rebuild the local dev database**

The rewrite changes an already-applied local migration, so the local D1 must be recreated from scratch. **This destroys local dev users and wallets** — it is the cost of rewriting `0009` in place, and remote is untouched.

```bash
cd backend
rm -f .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite*
npm run migrate:local
```

Expected: all twelve migrations apply with no error.

- [ ] **Step 12: Typecheck and commit**

```bash
cd backend && npm run typecheck
```

```bash
git add backend/migrations backend/src/modules/networks/networkTypes.ts \
        backend/src/modules/cards/queries.ts backend/test/networks.test.ts \
        backend/test/cardsWrite.test.ts
git commit -m "refactor(db): make networks and their BIN prefix rules tables

0009 held the network set in a CHECK enum and the whole ISO/IEC 7812 prefix
table in a second CHECK. Neither survives an admin being able to add a
network, so both become rows: networks and network_bin_rules. card_networks
and card_bins now key on network_id.

Codes still cross the API boundary in both directions -- the three queries
that touched the old column resolve them by join -- so no response shape
changes and no existing test needed rewriting beyond the two that read
card_networks directly.

Also adds cards.type, defaulting to credit, which the whole seeded catalog
already is. 0009 and 0010 are rewritten in place rather than patched
forward: remote D1 has never had them."
```

---

### Task 2: The BIN prefix rule matcher

A pure function, no DB, so it unit-tests without a Worker. Lands in `modules/networks/` ahead of the rest of that module because nothing else depends on it.

**Files:**
- Create: `backend/src/modules/networks/binRules.ts`
- Create: `backend/test/binRules.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type BinRuleKind = 'glob' | 'range'`; `type BinRule = { kind: BinRuleKind; value: string }`; `BIN_RULE_KINDS: readonly BinRuleKind[]`; `isBinRuleKind(value: unknown): value is BinRuleKind`; `isBinRuleValue(kind: BinRuleKind, value: string): boolean`; `matchesBinRules(prefix: string, rules: BinRule[]): boolean`.

The spec's test table put this in `validate.test.ts`. Splitting it out is a deliberate deviation: `validate.test.ts` covers request-shape validators, and this is a matcher with no request in it.

- [ ] **Step 1: Write the failing test**

Create `backend/test/binRules.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isBinRuleValue, matchesBinRules } from '../src/modules/networks/binRules'
import type { BinRule } from '../src/modules/networks/binRules'

const glob = (value: string): BinRule => ({ kind: 'glob', value })
const range = (value: string): BinRule => ({ kind: 'range', value })

describe('matchesBinRules', () => {
  it('matches a plain glob prefix', () => {
    expect(matchesBinRules('412345', [glob('4*')])).toBe(true)
    expect(matchesBinRules('512345', [glob('4*')])).toBe(false)
  })

  it('honours a character class', () => {
    const rules = [glob('5[1-5]*')]
    expect(matchesBinRules('512345', rules)).toBe(true)
    expect(matchesBinRules('552345', rules)).toBe(true)
    expect(matchesBinRules('562345', rules)).toBe(false)
    expect(matchesBinRules('502345', rules)).toBe(false)
  })

  it('matches an 8-digit prefix against the same glob', () => {
    expect(matchesBinRules('41234567', [glob('4*')])).toBe(true)
  })

  it('anchors at both ends, so a glob must end in * to match a longer prefix', () => {
    expect(matchesBinRules('508123', [glob('508*')])).toBe(true)
    expect(matchesBinRules('508123', [glob('508')])).toBe(false)
  })

  it('matches a range at both bounds and misses outside them', () => {
    const rules = [range('2221-2720')]
    expect(matchesBinRules('222100', rules)).toBe(true)
    expect(matchesBinRules('272099', rules)).toBe(true)
    expect(matchesBinRules('222099', rules)).toBe(false)
    expect(matchesBinRules('272100', rules)).toBe(false)
  })

  it('accepts a prefix matching any one rule of several', () => {
    const rules = [glob('5[1-5]*'), range('2221-2720')]
    expect(matchesBinRules('222100', rules)).toBe(true)
    expect(matchesBinRules('512345', rules)).toBe(true)
    expect(matchesBinRules('612345', rules)).toBe(false)
  })

  it('matches nothing when there are no rules', () => {
    expect(matchesBinRules('412345', [])).toBe(false)
  })

  /**
   * Every glob the deleted CHECK in 0009 enforced, against a prefix that should
   * pass it. This is the regression guard on the transcription in 0010.
   */
  it('reproduces every rule the old SQL CHECK enforced', () => {
    const cases: Array<[BinRule, string]> = [
      [glob('4*'), '412345'],
      [glob('5[1-5]*'), '531234'],
      [range('2221-2720'), '250012'],
      [glob('3[47]*'), '341234'],
      [glob('3[68]*'), '361234'],
      [glob('30[0-5]*'), '300412'],
      [glob('6[05]*'), '601234'],
      [glob('8[12]*'), '811234'],
      [glob('508*'), '508123'],
      [glob('6011*'), '601100'],
      [glob('64[4-9]*'), '644123'],
      [glob('65*'), '651234'],
      [range('3528-3589'), '355012'],
      [glob('62*'), '621234'],
      [glob('81*'), '811234'],
    ]
    for (const [rule, prefix] of cases) {
      expect(matchesBinRules(prefix, [rule]), `${rule.value} vs ${prefix}`).toBe(true)
    }
  })
})

describe('isBinRuleValue', () => {
  it('accepts the glob alphabet the CHECK admits', () => {
    for (const value of ['4*', '5[1-5]*', '30[0-5]*', '6011*', '64[4-9]*']) {
      expect(isBinRuleValue('glob', value), value).toBe(true)
    }
  })

  /**
   * The same set migration 0009's CHECK rejects. These are what would turn the
   * glob-to-RegExp translation into an injection if either layer let them by.
   */
  it('rejects every regex metacharacter', () => {
    for (const value of ['4|5*', '4^5*', '4$*', '4+*', '4.*', '4(a)*', '4\\d*', '4 *']) {
      expect(isBinRuleValue('glob', value), value).toBe(false)
    }
  })

  it('requires a range to be two four-digit bounds, low first', () => {
    expect(isBinRuleValue('range', '2221-2720')).toBe(true)
    expect(isBinRuleValue('range', '222-2720')).toBe(false)
    expect(isBinRuleValue('range', '2221_2720')).toBe(false)
    expect(isBinRuleValue('range', 'abcd-efgh')).toBe(false)
    expect(isBinRuleValue('range', '2720-2221')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/binRules.test.ts`
Expected: FAIL — cannot resolve `../src/modules/networks/binRules`.

- [ ] **Step 3: Write the matcher**

Create `backend/src/modules/networks/binRules.ts`:

```ts
/**
 * A network's BIN prefix rules, and the matcher that applies them.
 *
 * These used to be one CHECK constraint on card_bins, which was the better
 * place for them: no write path could bypass it. A CHECK cannot subquery a
 * table, so once networks became rows an admin can add, the rules had to move
 * here. This module is now the one door -- cards/validate.ts is its only
 * caller, and the admin API is the only write path that reaches it.
 *
 * Pure and DB-free on purpose, so it tests without a Worker.
 */

export const BIN_RULE_KINDS = ['glob', 'range'] as const

export type BinRuleKind = (typeof BIN_RULE_KINDS)[number]

export type BinRule = {
  kind: BinRuleKind
  value: string
}

export function isBinRuleKind(value: unknown): value is BinRuleKind {
  return typeof value === 'string' && (BIN_RULE_KINDS as readonly string[]).includes(value)
}

/**
 * A glob may hold only digits, '[', ']', '-' and '*'. Mirrors the CHECK on
 * network_bin_rules -- change one, change the other -- and it is what makes
 * globToRegExp below safe: no regex metacharacter can reach it.
 */
const GLOB_ALPHABET = /^[0-9[\]\-*]+$/

/** Two 4-digit bounds, low first. */
const RANGE_SHAPE = /^(\d{4})-(\d{4})$/

export function isBinRuleValue(kind: BinRuleKind, value: string): boolean {
  if (kind === 'glob') return GLOB_ALPHABET.test(value)

  const match = RANGE_SHAPE.exec(value)
  return match !== null && Number(match[1]) <= Number(match[2])
}

/**
 * SQLite GLOB and RegExp agree on everything the alphabet above permits: a
 * character class means the same in both, digits are literal in both, and '*'
 * is the only wildcard. So the translation is a single replacement.
 *
 * Anchored at both ends, which is why a rule has to end in '*' to match a
 * prefix longer than itself. '508' matches only the literal string '508'.
 */
function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replaceAll('*', '.*')}$`)
}

/** Inclusive, against the prefix's leading four digits. */
function inRange(prefix: string, value: string): boolean {
  const match = RANGE_SHAPE.exec(value)
  if (!match) return false

  const head = Number.parseInt(prefix.slice(0, 4), 10)
  return head >= Number(match[1]) && head <= Number(match[2])
}

/** A prefix is valid for a network when *any* of its rules matches. */
export function matchesBinRules(prefix: string, rules: BinRule[]): boolean {
  return rules.some((rule) =>
    rule.kind === 'glob' ? globToRegExp(rule.value).test(prefix) : inRange(prefix, rule.value),
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run test/binRules.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/networks/binRules.ts backend/test/binRules.test.ts
git commit -m "feat(networks): add the BIN prefix rule matcher

Replaces the ISO/IEC 7812 CHECK deleted from 0009 with a pure matcher over
network_bin_rules rows. Globs translate straight to an anchored RegExp,
which is only safe because both the CHECK and isBinRuleValue restrict the
alphabet to digits, brackets, dash and star -- tested against the eight
metacharacter forms that would otherwise inject.

The regression test walks all fifteen rules the old CHECK enforced."
```

---

### Task 3: `/v1/networks` admin CRUD

A new module following `modules/banks/` exactly, except that reads are admin-guarded too — this resource has no public consumer.

**Files:**
- Create: `backend/src/modules/networks/queries.ts`
- Create: `backend/src/modules/networks/validate.ts`
- Create: `backend/src/modules/networks/routes.ts`
- Modify: `backend/src/modules/networks/networkTypes.ts`
- Modify: `backend/src/index.ts:36-42`
- Modify: `backend/test/networks.test.ts`

**Interfaces:**
- Consumes: `BinRule`, `BinRuleKind`, `isBinRuleKind`, `isBinRuleValue` from Task 2; `generateNetworkId`, `NETWORK_ID_PATTERN` from Task 1.
- Produces: `type Network = { id, code, name, isActive, binRules }`; `NetworkInput`, `NetworkPatch`, `NetworkFilters`; `listNetworks(db, filters)`, `getNetwork(db, id)`, `createNetwork(db, input)`, `updateNetwork(db, id, patch)`, `deactivateNetwork(db, id)`; and — consumed by Task 4 — `type NetworkForValidation = { id: string; code: string; isActive: boolean; binRules: BinRule[] }` plus `listNetworksForValidation(db): Promise<NetworkForValidation[]>`.

- [ ] **Step 1: Write the failing CRUD tests**

Append to `backend/test/networks.test.ts`:

```ts
import { SELF } from 'cloudflare:test'

const base = 'http://api.test'
const AUTH = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }

function send(method: string, path: string, body?: unknown) {
  return SELF.fetch(`${base}${path}`, {
    method,
    headers: AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function json(res: Response) {
  return (await res.json()) as any
}

let unique = 0
function network(overrides: Record<string, unknown> = {}) {
  unique += 1
  return {
    code: `testnet${unique}`,
    name: `Test Network ${unique}`,
    binRules: [{ kind: 'glob', value: '9*' }],
    ...overrides,
  }
}

describe('/v1/networks', () => {
  it('mints a network_-prefixed id and echoes its rules', async () => {
    const res = await send('POST', '/v1/networks', network({ name: 'Elo' }))
    expect(res.status).toBe(201)

    const body = await json(res)
    expect(body.id).toMatch(NETWORK_ID_PATTERN)
    expect(res.headers.get('Location')).toBe(`/v1/networks/${body.id}`)
    expect(body.name).toBe('Elo')
    expect(body.isActive).toBe(true)
    expect(body.binRules).toEqual([{ kind: 'glob', value: '9*' }])
  })

  it('rejects a duplicate code with 409', async () => {
    const dup = network({ code: 'dupnet' })
    await send('POST', '/v1/networks', dup)
    const res = await send('POST', '/v1/networks', dup)
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('conflict')
  })

  it('rejects a code that is not lowercase alphanumeric', async () => {
    const res = await send('POST', '/v1/networks', network({ code: 'Bad Code' }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toContain('code')
  })

  it('requires at least one bin rule', async () => {
    const res = await send('POST', '/v1/networks', network({ binRules: [] }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(/at least one/)
  })

  it('rejects a glob carrying a regex metacharacter', async () => {
    const res = await send('POST', '/v1/networks', network({
      binRules: [{ kind: 'glob', value: '4|5*' }],
    }))
    expect(res.status).toBe(400)
  })

  it('rejects an unknown rule kind', async () => {
    const res = await send('POST', '/v1/networks', network({
      binRules: [{ kind: 'regex', value: '4.*' }],
    }))
    expect(res.status).toBe(400)
  })

  it('rejects a backwards range', async () => {
    const res = await send('POST', '/v1/networks', network({
      binRules: [{ kind: 'range', value: '2720-2221' }],
    }))
    expect(res.status).toBe(400)
  })

  it('replaces the whole rule set on patch rather than merging', async () => {
    const created = await json(await send('POST', '/v1/networks', network()))
    const res = await send('PATCH', `/v1/networks/${created.id}`, {
      binRules: [{ kind: 'range', value: '1000-1999' }],
    })
    expect(res.status).toBe(200)
    expect((await json(res)).binRules).toEqual([{ kind: 'range', value: '1000-1999' }])
  })

  it('leaves the rules alone when patch omits them', async () => {
    const created = await json(await send('POST', '/v1/networks', network()))
    const res = await send('PATCH', `/v1/networks/${created.id}`, { name: 'Renamed' })
    expect((await json(res)).binRules).toEqual([{ kind: 'glob', value: '9*' }])
  })

  it('clears the rules on an explicit empty patch', async () => {
    const created = await json(await send('POST', '/v1/networks', network()))
    const res = await send('PATCH', `/v1/networks/${created.id}`, { binRules: [] })
    expect((await json(res)).binRules).toEqual([])
  })

  it('soft-deletes, keeping the row and its rules', async () => {
    const created = await json(await send('POST', '/v1/networks', network()))
    expect((await send('DELETE', `/v1/networks/${created.id}`)).status).toBe(204)

    const after = await json(await send('GET', `/v1/networks/${created.id}`))
    expect(after.isActive).toBe(false)
    expect(after.binRules).toHaveLength(1)
  })

  it('omits inactive networks from the list unless asked', async () => {
    const created = await json(await send('POST', '/v1/networks', network()))
    await send('DELETE', `/v1/networks/${created.id}`)

    const listed = await json(await send('GET', '/v1/networks'))
    expect(listed.data.some((n: any) => n.id === created.id)).toBe(false)

    const all = await json(await send('GET', '/v1/networks?includeInactive=true'))
    expect(all.data.some((n: any) => n.id === created.id)).toBe(true)
  })

  it('404s an unknown id', async () => {
    const res = await send('GET', '/v1/networks/network_ffffffffffffffffffffffffffffffff')
    expect(res.status).toBe(404)
  })

  /**
   * Reads are admin-guarded too, which departs from /v1/banks and /v1/cards.
   * Nothing public consumes this resource, so it is not published.
   */
  it('requires an admin token on every verb, reads included', async () => {
    for (const [method, path] of [
      ['GET', '/v1/networks'],
      ['GET', '/v1/networks/network_ffffffffffffffffffffffffffffffff'],
      ['POST', '/v1/networks'],
      ['PATCH', '/v1/networks/network_ffffffffffffffffffffffffffffffff'],
      ['DELETE', '/v1/networks/network_ffffffffffffffffffffffffffffffff'],
    ] as const) {
      const res = await SELF.fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
      })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/networks.test.ts`
Expected: FAIL — every `/v1/networks` request 404s; the route is not mounted.

- [ ] **Step 3: Extend the network types**

Append to `backend/src/modules/networks/networkTypes.ts`:

```ts
import type { BinRule } from './binRules'

/**
 * A payment network. `binRules` travels with it everywhere: a network without
 * its prefix rules cannot validate a BIN, so nothing wants one without the
 * other.
 */
export type Network = {
  id: string
  code: string
  name: string
  isActive: boolean
  binRules: BinRule[]
}

export type NetworkInput = {
  code: string
  name: string
  binRules: BinRule[]
  isActive?: boolean
}

export type NetworkPatch = Partial<NetworkInput>

export type NetworkFilters = {
  q?: string
  includeInactive: boolean
  limit: number
  offset: number
}
```

- [ ] **Step 4: Write the queries**

Create `backend/src/modules/networks/queries.ts`:

```ts
import { ApiError } from '../../http/errors'
import { likePattern } from '../../http/params'
import { generateNetworkId } from './networkTypes'
import type { BinRule } from './binRules'
import type { Network, NetworkFilters, NetworkInput, NetworkPatch } from './networkTypes'

/**
 * This module owns `networks` and `network_bin_rules` and reads nothing else.
 * cards/queries.ts joins to `networks` to resolve a code, which is a read, and
 * the documented direction of that dependency.
 */

type NetworkRow = {
  id: string
  code: string
  name: string
  is_active: number
}

type RuleRow = {
  network_id: string
  kind: BinRule['kind']
  value: string
}

const NETWORK_COLUMNS = 'id, code, name, is_active'
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

function toNetwork(row: NetworkRow, rules: BinRule[]): Network {
  return { id: row.id, code: row.code, name: row.name, isActive: row.is_active === 1, binRules: rules }
}

/** Rules for a set of networks, in one query rather than one per network. */
async function rulesFor(db: D1Database, ids: string[]): Promise<Map<string, BinRule[]>> {
  const byNetwork = new Map<string, BinRule[]>()
  if (ids.length === 0) return byNetwork

  const marks = ids.map(() => '?').join(',')
  const { results } = await db
    .prepare(
      `SELECT network_id, kind, value FROM network_bin_rules
       WHERE network_id IN (${marks}) ORDER BY kind, value`,
    )
    .bind(...ids)
    .all<RuleRow>()

  for (const row of results) {
    const existing = byNetwork.get(row.network_id)
    if (existing) existing.push({ kind: row.kind, value: row.value })
    else byNetwork.set(row.network_id, [{ kind: row.kind, value: row.value }])
  }
  return byNetwork
}

function buildWhere(f: NetworkFilters): { clause: string; binds: unknown[] } {
  const conds: string[] = []
  const binds: unknown[] = []

  if (!f.includeInactive) conds.push('is_active = 1')
  if (f.q) {
    conds.push("(name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')")
    const pattern = likePattern(f.q)
    binds.push(pattern, pattern)
  }

  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', binds }
}

export async function listNetworks(
  db: D1Database,
  filters: NetworkFilters,
): Promise<{ networks: Network[]; total: number }> {
  const { clause, binds } = buildWhere(filters)

  const [page, count] = await db.batch<NetworkRow & { total: number }>([
    db
      .prepare(
        `SELECT ${NETWORK_COLUMNS} FROM networks ${clause}
         ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, filters.limit, filters.offset),
    db.prepare(`SELECT COUNT(*) AS total FROM networks ${clause}`).bind(...binds),
  ])

  const rows = page.results as NetworkRow[]
  const rules = await rulesFor(db, rows.map((row) => row.id))

  return {
    networks: rows.map((row) => toNetwork(row, rules.get(row.id) ?? [])),
    total: count.results[0]?.total ?? 0,
  }
}

export async function getNetwork(db: D1Database, id: string): Promise<Network | null> {
  const row = await db
    .prepare(`SELECT ${NETWORK_COLUMNS} FROM networks WHERE id = ?`)
    .bind(id)
    .first<NetworkRow>()
  if (!row) return null

  const rules = await rulesFor(db, [row.id])
  return toNetwork(row, rules.get(row.id) ?? [])
}

/**
 * Every network with its rules, active or not, for cards/validate.ts.
 *
 * Inactive ones are included on purpose: the validator has to tell "no such
 * network" apart from "that network is retired", and those are different
 * messages to an admin.
 */
export type NetworkForValidation = {
  id: string
  code: string
  isActive: boolean
  binRules: BinRule[]
}

export async function listNetworksForValidation(
  db: D1Database,
): Promise<NetworkForValidation[]> {
  const { results } = await db
    .prepare(`SELECT ${NETWORK_COLUMNS} FROM networks`)
    .all<NetworkRow>()

  const rules = await rulesFor(db, results.map((row) => row.id))
  return results.map((row) => ({
    id: row.id,
    code: row.code,
    isActive: row.is_active === 1,
    binRules: rules.get(row.id) ?? [],
  }))
}

async function requireNetwork(db: D1Database, id: string): Promise<void> {
  const found = await db.prepare('SELECT 1 FROM networks WHERE id = ?').bind(id).first()
  if (!found) throw ApiError.notFound(`Network '${id}'`)
}

/** Replaces the whole rule set, so repeated calls cannot accumulate duplicates. */
async function replaceRules(db: D1Database, id: string, rules: BinRule[]): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM network_bin_rules WHERE network_id = ?').bind(id),
    ...rules.map((rule) =>
      db
        .prepare(
          `INSERT INTO network_bin_rules (network_id, kind, value) VALUES (?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(id, rule.kind, rule.value),
    ),
  ])
}

export async function createNetwork(db: D1Database, input: NetworkInput): Promise<Network> {
  const id = generateNetworkId()

  try {
    await db
      .prepare('INSERT INTO networks (id, code, name, is_active) VALUES (?, ?, ?, ?)')
      .bind(id, input.code, input.name, input.isActive === false ? 0 : 1)
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict(`A network with code '${input.code}' already exists.`)
    }
    throw err
  }

  await replaceRules(db, id, input.binRules)

  const network = await getNetwork(db, id)
  if (!network) throw new Error(`Network '${id}' vanished immediately after insert`)
  return network
}

export async function updateNetwork(
  db: D1Database,
  id: string,
  patch: NetworkPatch,
): Promise<Network> {
  await requireNetwork(db, id)

  const sets: string[] = []
  const binds: unknown[] = []
  if (patch.code !== undefined) {
    sets.push('code = ?')
    binds.push(patch.code)
  }
  if (patch.name !== undefined) {
    sets.push('name = ?')
    binds.push(patch.name)
  }
  if (patch.isActive !== undefined) {
    sets.push('is_active = ?')
    binds.push(patch.isActive ? 1 : 0)
  }

  if (sets.length > 0) {
    sets.push(`updated_at = ${NOW}`)
    try {
      await db.prepare(`UPDATE networks SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run()
    } catch (err) {
      if (isUniqueViolation(err)) throw ApiError.conflict('Another network already uses that code.')
      throw err
    }
  }

  // Omitted leaves the rules alone; `[]` clears them.
  if (patch.binRules !== undefined) await replaceRules(db, id, patch.binRules)

  const network = await getNetwork(db, id)
  if (!network) throw ApiError.notFound(`Network '${id}'`)
  return network
}

/**
 * Soft delete. card_networks holds a foreign key to networks, so a hard delete
 * would either fail or orphan the catalog. A retired network keeps its existing
 * card associations and keeps working as a ?network= filter value; what changes
 * is that card writes reject it.
 */
export async function deactivateNetwork(db: D1Database, id: string): Promise<void> {
  await requireNetwork(db, id)
  await db
    .prepare(`UPDATE networks SET is_active = 0, updated_at = ${NOW} WHERE id = ?`)
    .bind(id)
    .run()
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}
```

- [ ] **Step 5: Write the validator**

Create `backend/src/modules/networks/validate.ts`:

```ts
import { checkText, isPlainObject, rejectClientId } from '../../http/validators'
import { BIN_RULE_KINDS, isBinRuleKind, isBinRuleValue } from './binRules'
import type { BinRule } from './binRules'
import type { NetworkInput, NetworkPatch } from './networkTypes'

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/** Matches the CHECK on networks.code in migration 0009. */
const CODE_PATTERN = /^[a-z0-9]{2,20}$/

function checkCode(value: unknown, errors: string[]): string | undefined {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!CODE_PATTERN.test(raw)) {
    errors.push('code must be 2 to 20 lowercase letters or digits, e.g. "visa".')
    return undefined
  }
  return raw
}

/**
 * The prefix rules a network allocates under. Overlaps the CHECK constraints on
 * network_bin_rules on purpose: this exists to produce a good 400, the
 * constraints are the backstop.
 *
 * `allowEmpty` is the POST/PATCH difference. Creating a network with no rules
 * would create one no BIN can ever be added under; clearing them on an existing
 * network is a deliberate way to take it out of service for new BINs.
 */
function checkBinRules(
  value: unknown,
  allowEmpty: boolean,
  errors: string[],
): BinRule[] | undefined {
  if (!Array.isArray(value)) {
    errors.push('binRules must be an array.')
    return undefined
  }
  if (value.length === 0 && !allowEmpty) {
    errors.push('binRules must contain at least one rule.')
    return undefined
  }

  const rules: BinRule[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      errors.push('Each bin rule must be an object with a kind and a value.')
      continue
    }
    if (!isBinRuleKind(entry.kind)) {
      errors.push(`Rule kind must be one of ${BIN_RULE_KINDS.join(', ')}.`)
      continue
    }
    if (typeof entry.value !== 'string') {
      errors.push('Rule value must be a string.')
      continue
    }
    if (!isBinRuleValue(entry.kind, entry.value)) {
      errors.push(
        entry.kind === 'glob'
          ? `Glob '${entry.value}' may contain only digits, [ ] - and *.`
          : `Range '${entry.value}' must be two four-digit bounds, low first, e.g. "2221-2720".`,
      )
      continue
    }
    if (rules.some((r) => r.kind === entry.kind && r.value === entry.value)) continue
    rules.push({ kind: entry.kind, value: entry.value })
  }

  return errors.length > 0 ? undefined : rules
}

export function validateNetworkInput(body: unknown): Validated<NetworkInput> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)
  const code = checkCode(body.code, errors)
  const name = checkText(body.name, 'name', 40, errors)
  const binRules = checkBinRules(body.binRules, false, errors)

  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    errors.push('isActive must be a boolean.')
  }

  if (errors.length > 0 || code === undefined || name === undefined || binRules === undefined) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: { code, name, binRules, isActive: body.isActive as boolean | undefined },
  }
}

export function validateNetworkPatch(body: unknown): Validated<NetworkPatch> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)

  const patch: NetworkPatch = {}
  if (body.code !== undefined) patch.code = checkCode(body.code, errors)
  if (body.name !== undefined) patch.name = checkText(body.name, 'name', 40, errors)
  if (body.binRules !== undefined) patch.binRules = checkBinRules(body.binRules, true, errors)
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') errors.push('isActive must be a boolean.')
    else patch.isActive = body.isActive
  }

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push('Provide at least one field to update.')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: patch }
}
```

- [ ] **Step 6: Write the routes**

Create `backend/src/modules/networks/routes.ts`:

```ts
import { Hono } from 'hono'
import { adminAuth } from '../../http/adminAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import { parseBool, parseLimit, parseOffset } from '../../http/params'
import type { AppEnv } from '../../env'
import {
  createNetwork,
  deactivateNetwork,
  getNetwork,
  listNetworks,
  updateNetwork,
} from './queries'
import { validateNetworkInput, validateNetworkPatch } from './validate'

/**
 * Admin-only throughout, reads included -- which departs from /v1/banks and
 * /v1/cards, where GET is public.
 *
 * The reason is that this resource has no public consumer: the frontend calls
 * only /v1/cards, /v1/wallet* and /v1/verifications*, takes the issuer name
 * from the card's own `issuer` field, and shows no network anywhere. The admin
 * panel is the sole reader. Publishing it later, if a network badge on a card
 * ever wants it, is a one-line change; un-publishing it once a client depends
 * on it is not.
 *
 * Five handlers, five adminAuth.
 */
export const networkRoutes = new Hono<AppEnv>()

networkRoutes.get('/', adminAuth, async (c) => {
  const query = c.req.query('q')?.trim()
  const { networks, total } = await listNetworks(c.env.DB, {
    q: query ? query : undefined,
    includeInactive: parseBool(c.req.query('includeInactive')),
    limit: parseLimit(c.req.query('limit')),
    offset: parseOffset(c.req.query('offset')),
  })
  return c.json({ data: networks, total })
})

networkRoutes.get('/:id', adminAuth, async (c) => {
  const id = c.req.param('id')
  const network = await getNetwork(c.env.DB, id)
  if (!network) throw ApiError.notFound(`Network '${id}'`)
  return c.json(network)
})

networkRoutes.post('/', adminAuth, async (c) => {
  const result = validateNetworkInput(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const network = await createNetwork(c.env.DB, result.value)
  c.header('Location', `/v1/networks/${network.id}`)
  return c.json(network, 201)
})

networkRoutes.patch('/:id', adminAuth, async (c) => {
  const result = validateNetworkPatch(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  return c.json(await updateNetwork(c.env.DB, c.req.param('id'), result.value))
})

networkRoutes.delete('/:id', adminAuth, async (c) => {
  await deactivateNetwork(c.env.DB, c.req.param('id'))
  return c.body(null, 204)
})
```

- [ ] **Step 7: Mount the route**

In `backend/src/index.ts`, add the import alongside the others and one `app.route` line after the `/v1/cards` line:

```ts
import { networkRoutes } from './modules/networks/routes'
```

```ts
app.route('/v1/networks', networkRoutes)
```

- [ ] **Step 8: Run the tests**

Run: `cd backend && npx vitest run test/networks.test.ts`
Expected: PASS, 19 tests.

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
cd backend && npm run typecheck
```

```bash
git add backend/src/modules/networks backend/src/index.ts backend/test/networks.test.ts
git commit -m "feat(networks): add admin CRUD for /v1/networks

Follows modules/banks, with one departure: reads are admin-guarded too.
Nothing public consumes this resource -- the frontend calls only /v1/cards,
/v1/wallet* and /v1/verifications*, and no screen shows a network -- so it
is not published. Relaxing that later is one line; retracting it is not.

binRules replaces rather than merges on PATCH, matching PUT
/v1/cards/:id/scores. Omitted leaves the rules alone, [] clears them, and
POST requires at least one: a network with no rules is one no BIN can be
added under.

listNetworksForValidation returns inactive networks too, so cards/validate
can tell 'no such network' from 'that network is retired'."
```

---

### Task 4: Networks and BINs written together on a card

Replaces `networks: ["visa"]` with `networks: [{ code, bins }]`, which is what lets an admin create a complete card in one call. Removes the 409 that guarded against dropping a network out from under its BINs — the caller now states both together, so a replace legitimately drops both.

**Files:**
- Modify: `backend/src/modules/cards/cardTypes.ts:12-47,103-118`
- Modify: `backend/src/modules/cards/validate.ts:1-11,23-50,52,69,96,120`
- Modify: `backend/src/modules/cards/queries.ts:1-15,218,243-264,289-295,333-339,357-373`
- Modify: `backend/src/modules/cards/routes.ts:81-95`
- Modify: `backend/test/cardsWrite.test.ts:225-330`
- Modify: `backend/test/validate.test.ts`

**Interfaces:**
- Consumes: `matchesBinRules`, `BinRule` (Task 2); `listNetworksForValidation`, `NetworkForValidation` (Task 3).
- Produces: `type CardNetworkInput = { code: string; bins: string[] }`; `CardInput.networks?: CardNetworkInput[]`; `validateCardInput(body, networks)` and `validateCardPatch(body, networks)` both taking `NetworkForValidation[]` as a second argument. `CardNetwork.network` widens from `NetworkCode` to `string`. `NETWORK_CODES`, `NetworkCode` and `isNetworkCode` are deleted.

- [ ] **Step 1: Write the failing write tests**

In `backend/test/cardsWrite.test.ts`, replace the whole `describe('card networks on write', ...)` block (lines 225 to the end of that describe) with:

```ts
describe('card networks and bins on write', () => {
  /** The network codes the table holds for a card, sorted. */
  async function networksOf(cardId: string): Promise<string[]> {
    const { results } = await env.DB.prepare(
      `SELECT nw.code AS network
       FROM card_networks cn
       JOIN networks nw ON nw.id = cn.network_id
       WHERE cn.card_id = ?
       ORDER BY nw.code`,
    )
      .bind(cardId)
      .all()
    return results.map((row: any) => row.network)
  }

  /** `code:prefix` pairs the table holds for a card, sorted. */
  async function binsOf(cardId: string): Promise<string[]> {
    const { results } = await env.DB.prepare(
      `SELECT nw.code AS network, cb.bin_prefix
       FROM card_bins cb
       JOIN networks nw ON nw.id = cb.network_id
       WHERE cb.card_id = ?
       ORDER BY nw.code, cb.bin_prefix`,
    )
      .bind(cardId)
      .all()
    return results.map((row: any) => `${row.network}:${row.bin_prefix}`)
  }

  it('keeps networks and bins off the created card', async () => {
    const body = await json(
      await send('POST', '/v1/cards', card({ networks: [{ code: 'visa', bins: ['412345'] }] })),
    )
    expect(body).not.toHaveProperty('networks')
    expect(body).not.toHaveProperty('bins')
  })

  it('writes nothing when no network is given', async () => {
    const body = await json(await send('POST', '/v1/cards', card()))
    expect(await networksOf(body.id)).toEqual([])
    expect(await binsOf(body.id)).toEqual([])
  })

  it('stores networks and their bins together', async () => {
    const body = await json(
      await send('POST', '/v1/cards', card({
        networks: [
          { code: 'visa', bins: ['412345', '45678901'] },
          { code: 'mastercard', bins: ['521234'] },
        ],
      })),
    )
    expect(await networksOf(body.id)).toEqual(['mastercard', 'visa'])
    expect(await binsOf(body.id)).toEqual([
      'mastercard:521234',
      'visa:412345',
      'visa:45678901',
    ])
  })

  it('accepts a network with no bins, leaving it unselectable', async () => {
    const body = await json(
      await send('POST', '/v1/cards', card({ networks: [{ code: 'visa' }] })),
    )
    expect(await networksOf(body.id)).toEqual(['visa'])
    expect(await binsOf(body.id)).toEqual([])
  })

  it('replaces both networks and bins on patch', async () => {
    const created = await json(
      await send('POST', '/v1/cards', card({
        networks: [{ code: 'visa', bins: ['412345'] }],
      })),
    )

    const res = await send('PATCH', `/v1/cards/${created.id}`, {
      networks: [{ code: 'rupay', bins: ['652345'] }],
    })
    expect(res.status).toBe(200)
    expect(await networksOf(created.id)).toEqual(['rupay'])
    expect(await binsOf(created.id)).toEqual(['rupay:652345'])
  })

  /**
   * The 409 this used to raise is gone. The caller now states networks and
   * bins in one breath, so replacing legitimately drops both -- there is no
   * data the caller did not mention.
   */
  it('drops a network together with its bins rather than 409ing', async () => {
    const created = await json(
      await send('POST', '/v1/cards', card({
        networks: [{ code: 'visa', bins: ['412345'] }],
      })),
    )

    const res = await send('PATCH', `/v1/cards/${created.id}`, {
      networks: [{ code: 'rupay', bins: [] }],
    })
    expect(res.status).toBe(200)
    expect(await networksOf(created.id)).toEqual(['rupay'])
    expect(await binsOf(created.id)).toEqual([])
  })

  it('clears everything on an explicit empty networks array', async () => {
    const created = await json(
      await send('POST', '/v1/cards', card({
        networks: [{ code: 'visa', bins: ['412345'] }],
      })),
    )

    const res = await send('PATCH', `/v1/cards/${created.id}`, { networks: [] })
    expect(res.status).toBe(200)
    expect(await networksOf(created.id)).toEqual([])
    expect(await binsOf(created.id)).toEqual([])
  })

  it('is idempotent under a repeated patch', async () => {
    const created = await json(await send('POST', '/v1/cards', card()))
    const body = { networks: [{ code: 'visa', bins: ['412345'] }] }

    await send('PATCH', `/v1/cards/${created.id}`, body)
    await send('PATCH', `/v1/cards/${created.id}`, body)
    expect(await networksOf(created.id)).toEqual(['visa'])
    expect(await binsOf(created.id)).toEqual(['visa:412345'])
  })

  it('keeps the other fields when only networks change', async () => {
    const created = await json(await send('POST', '/v1/cards', card({ annualFee: 2500 })))
    const patched = await json(
      await send('PATCH', `/v1/cards/${created.id}`, {
        networks: [{ code: 'visa', bins: ['412345'] }],
      }),
    )
    expect(patched.annualFee).toBe(2500)
    expect(patched.name).toBe(created.name)
  })

  it('rejects a bin that does not match its network rules', async () => {
    const res = await send('POST', '/v1/cards', card({
      networks: [{ code: 'visa', bins: ['512345'] }],
    }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(
      /BIN '512345' is not valid for network 'visa'/,
    )
  })

  it('rejects a bin that is not 6 or 8 digits', async () => {
    const res = await send('POST', '/v1/cards', card({
      networks: [{ code: 'visa', bins: ['4123'] }],
    }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(/6 or 8 digits/)
  })

  it('rejects an unknown network code', async () => {
    const res = await send('POST', '/v1/cards', card({ networks: [{ code: 'switch' }] }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(/not a known network/)
  })

  it('rejects an inactive network', async () => {
    const made = await json(
      await send('POST', '/v1/networks', {
        code: 'retirednet',
        name: 'Retired Net',
        binRules: [{ kind: 'glob', value: '9*' }],
      }),
    )
    await send('DELETE', `/v1/networks/${made.id}`)

    const res = await send('POST', '/v1/cards', card({
      networks: [{ code: 'retirednet', bins: ['912345'] }],
    }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(/is not active/)
  })

  it('rejects bins on a network with no rules on file', async () => {
    const made = await json(
      await send('POST', '/v1/networks', {
        code: 'rulelessnet',
        name: 'Ruleless Net',
        binRules: [{ kind: 'glob', value: '9*' }],
      }),
    )
    await send('PATCH', `/v1/networks/${made.id}`, { binRules: [] })

    const res = await send('POST', '/v1/cards', card({
      networks: [{ code: 'rulelessnet', bins: ['912345'] }],
    }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(/has no BIN rules on file/)
  })

  it('rejects a repeated network', async () => {
    const res = await send('POST', '/v1/cards', card({
      networks: [{ code: 'visa', bins: [] }, { code: 'visa', bins: [] }],
    }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(/listed twice/)
  })

  it('rejects the same bin under two networks', async () => {
    const res = await send('POST', '/v1/cards', card({
      networks: [
        { code: 'rupay', bins: ['652345'] },
        { code: 'discover', bins: ['652345'] },
      ],
    }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(/more than one network/)
  })

  it('rejects a network entry that is not an object', async () => {
    const res = await send('POST', '/v1/cards', card({ networks: ['visa'] }))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/cardsWrite.test.ts`
Expected: FAIL — the old validator rejects the object form with `networks must contain only visa, mastercard, ...`.

- [ ] **Step 3: Replace the network types on the card**

In `backend/src/modules/cards/cardTypes.ts`, delete the `NETWORK_CODES` / `NetworkCode` / `isNetworkCode` block (lines 12-33) and replace it with nothing — network codes are data now, so there is no compile-time union to keep in step with the database.

Change the `CardNetwork` type (lines 35-47) so its `network` is a plain code:

```ts
/**
 * One network a card runs on, with the BIN prefixes that network issues it
 * under. Internal: never serialised onto a card. `listCardNetworks` builds it
 * for the verification flow, which needs the prefixes to narrow Checkout.
 *
 * `network` is a code ('visa'), not an id -- ids do not leave the server.
 *
 * `bins` is a SUPERSET of the product's own prefixes, and often empty -- a
 * 6-digit BIN identifies issuer + network + tier, not an individual product.
 */
export type CardNetwork = {
  network: string
  /** 6- or 8-digit IIN prefixes, ascending. Empty when none is on file. */
  bins: string[]
}

/**
 * One network a card is issued on, as an admin writes it: the network's code
 * and the BIN prefixes to record under it.
 *
 * `bins` may be empty or absent. That is a real state -- the card runs on the
 * network but no prefix is on file -- and it is what makes the card
 * unselectable, because nothing can verify it.
 */
export type CardNetworkInput = {
  code: string
  bins: string[]
}
```

Change `CardInput.networks` (lines 110-115):

```ts
  /**
   * Replaces the card's whole network *and* BIN set rather than merging into
   * it, the same contract as PUT /v1/cards/:id/scores. Omitted leaves both
   * untouched; `[]` clears both, which is how an admin walks back a card they
   * got wrong.
   */
  networks?: CardNetworkInput[]
```

- [ ] **Step 4: Rewrite the card network validator**

In `backend/src/modules/cards/validate.ts`, replace the imports at lines 10-11:

```ts
import { matchesBinRules } from '../networks/binRules'
import type { NetworkForValidation } from '../networks/queries'
import type { CardInput, CardNetworkInput, CardPatch } from './cardTypes'
```

Replace the whole `checkNetworks` function (lines 23-50):

```ts
/** Matches the CHECK on card_bins.bin_prefix in migration 0009. */
const BIN_PATTERN = /^(\d{6}|\d{8})$/

/**
 * The BIN prefixes to record under one network of a card.
 *
 * `seen` spans the whole request: within a single card a prefix belongs to
 * exactly one network, which the primary key on card_bins also enforces. The
 * check is here so the caller gets a sentence rather than a constraint failure.
 */
function checkBins(
  value: unknown,
  network: NetworkForValidation,
  seen: Map<string, string>,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push(`bins for '${network.code}' must be an array.`)
    return undefined
  }
  if (value.length > 0 && network.binRules.length === 0) {
    errors.push(`Network '${network.code}' has no BIN rules on file; add them first.`)
    return undefined
  }

  const bins: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string' || !BIN_PATTERN.test(raw)) {
      errors.push(`BIN '${String(raw)}' must be 6 or 8 digits.`)
      continue
    }
    const owner = seen.get(raw)
    if (owner !== undefined && owner !== network.code) {
      errors.push(`BIN '${raw}' is listed under more than one network.`)
      continue
    }
    if (!matchesBinRules(raw, network.binRules)) {
      errors.push(`BIN '${raw}' is not valid for network '${network.code}'.`)
      continue
    }
    seen.set(raw, network.code)
    if (!bins.includes(raw)) bins.push(raw)
  }

  return bins
}

/**
 * The networks a card is issued on, with the prefixes under each.
 *
 * `known` carries inactive networks too, so an unknown code and a retired one
 * get different messages -- they are different mistakes.
 *
 * An empty array is accepted and means "on no networks", which clears both
 * tables. That relaxes the previous rule: an admin editing a card they got
 * wrong needs a way back to empty, and a card with no networks is a real if
 * unselectable state.
 */
function checkNetworks(
  value: unknown,
  known: NetworkForValidation[],
  errors: string[],
): CardNetworkInput[] | undefined {
  if (!Array.isArray(value)) {
    errors.push('networks must be an array.')
    return undefined
  }

  const out: CardNetworkInput[] = []
  const seenCodes = new Set<string>()
  const seenBins = new Map<string, string>()

  for (const entry of value) {
    if (!isPlainObject(entry)) {
      errors.push('Each network must be an object with a code and bins.')
      continue
    }

    const code = typeof entry.code === 'string' ? entry.code.trim().toLowerCase() : ''
    const network = known.find((n) => n.code === code)
    if (!network) {
      errors.push(`'${code}' is not a known network.`)
      continue
    }
    if (!network.isActive) {
      errors.push(`Network '${code}' is not active.`)
      continue
    }
    if (seenCodes.has(code)) {
      errors.push(`Network '${code}' is listed twice.`)
      continue
    }
    seenCodes.add(code)

    const bins = checkBins(entry.bins, network, seenBins, errors)
    if (bins === undefined) continue
    out.push({ code, bins })
  }

  return errors.length > 0 ? undefined : out
}
```

Change both entry points to take the network set. Line 52 becomes:

```ts
export function validateCardInput(
  body: unknown,
  networks: NetworkForValidation[],
): Validated<CardInput> {
```

Line 69 becomes:

```ts
  const cardNetworks =
    body.networks === undefined ? undefined : checkNetworks(body.networks, networks, errors)
```

...and the `networks` key in its returned value object becomes `networks: cardNetworks`.

Line 96 becomes:

```ts
export function validateCardPatch(
  body: unknown,
  networks: NetworkForValidation[],
): Validated<CardPatch> {
```

Line 120 becomes:

```ts
  if (body.networks !== undefined) {
    patch.networks = checkNetworks(body.networks, networks, errors)
  }
```

- [ ] **Step 5: Rewrite `replaceNetworks` to write both tables**

In `backend/src/modules/cards/queries.ts`, update the type imports at lines 7-14 to drop `NetworkCode` and add `CardNetworkInput`.

`NetworkCode` has one other use in this file: the row annotation inside `listCardNetworks`, added in Task 1 Step 8. Widen it to `string`, since codes are data now:

```ts
    .all<{ network: string; bin_prefix: string | null }>()
```

Then replace the whole `replaceNetworks` function (lines 236-264):

```ts
/**
 * Replaces a card's whole network *and* BIN set, matching PUT
 * /v1/cards/:id/scores rather than merging: repeated calls cannot accumulate
 * duplicates.
 *
 * Statement order matters and is not incidental. card_bins has a composite
 * foreign key onto card_networks, so every BIN goes before its parent can be
 * removed and after its parent exists:
 *
 *   1. delete all the card's BINs        -- frees the FK
 *   2. delete the networks not being kept
 *   3. insert the networks               -- parents first
 *   4. insert the BINs                   -- children second
 *
 * Wiping all the BINs in step 1 rather than only the dropped networks' is what
 * makes this a replace. It also retires the 409 this used to raise: the caller
 * has stated both halves, so there is no unmentioned data to protect.
 */
async function replaceNetworks(
  db: D1Database,
  cardId: string,
  networks: CardNetworkInput[],
  idByCode: Map<string, string>,
): Promise<void> {
  const ids = networks.map((n) => idByCode.get(n.code)).filter((id): id is string => id !== undefined)

  // `NOT IN ()` is not valid SQL, so an empty set drops the clause rather than
  // emitting it -- which is exactly the `networks: []` case.
  const keep = ids.length > 0 ? `AND network_id NOT IN (${placeholders(ids.length)})` : ''

  const statements = [
    db.prepare('DELETE FROM card_bins WHERE card_id = ?').bind(cardId),
    db.prepare(`DELETE FROM card_networks WHERE card_id = ? ${keep}`).bind(cardId, ...ids),
  ]

  for (const network of networks) {
    const networkId = idByCode.get(network.code)
    if (networkId === undefined) continue
    statements.push(
      db
        .prepare(
          'INSERT INTO card_networks (card_id, network_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
        )
        .bind(cardId, networkId),
    )
  }

  for (const network of networks) {
    const networkId = idByCode.get(network.code)
    if (networkId === undefined) continue
    for (const bin of network.bins) {
      statements.push(
        db
          .prepare('INSERT INTO card_bins (card_id, network_id, bin_prefix) VALUES (?, ?, ?)')
          .bind(cardId, networkId, bin),
      )
    }
  }

  await db.batch(statements)
}
```

- [ ] **Step 6: Thread the code-to-id map through create and update**

In `backend/src/modules/cards/queries.ts`, change the signatures of `createCard` and `updateCard` to accept the map, and drop the `networksTouched` argument from both `mapWriteError` calls. `createCard`'s network block (lines 289-295) becomes:

```ts
  if (input.networks !== undefined) {
    await replaceNetworks(db, id, input.networks, idByCode)
  }
```

`updateCard`'s (lines 333-339) becomes:

```ts
  if (patch.networks !== undefined) {
    await replaceNetworks(db, id, patch.networks, idByCode)
  }
```

Both functions gain a fourth/third parameter respectively:

```ts
export async function createCard(
  db: D1Database,
  input: CardInput,
  idByCode: Map<string, string>,
): Promise<RatedCard> {
```

```ts
export async function updateCard(
  db: D1Database,
  id: string,
  patch: CardPatch,
  idByCode: Map<string, string>,
): Promise<RatedCard> {
```

And `mapWriteError` (lines 352-373) loses its network branch entirely:

```ts
/**
 * D1 enforces foreign keys, so an unknown bankId is caught by the database even
 * if it slipped past validation. Both constraints are mapped rather than left
 * to surface as a 500.
 */
function mapWriteError(err: unknown, name: string): unknown {
  if (!(err instanceof Error)) return err
  if (/UNIQUE constraint failed/i.test(err.message)) {
    return ApiError.conflict(`That bank already has a card named '${name}'.`)
  }
  if (/FOREIGN KEY constraint failed/i.test(err.message)) {
    return ApiError.validation(['bankId does not match a known bank.'])
  }
  return err
}
```

- [ ] **Step 7: Load the networks in the two write routes**

In `backend/src/modules/cards/routes.ts`, add the import:

```ts
import { listNetworksForValidation } from '../networks/queries'
```

Replace the `POST /` and `PATCH /:id` handlers (lines 81-95):

```ts
/**
 * Both writes load the network set first: validation needs each network's BIN
 * rules to check a prefix, and the write needs its id. One query serves both.
 */
async function networkContext(db: D1Database) {
  const networks = await listNetworksForValidation(db)
  return { networks, idByCode: new Map(networks.map((n) => [n.code, n.id])) }
}

cardRoutes.post('/', adminAuth, async (c) => {
  const { networks, idByCode } = await networkContext(c.env.DB)

  const result = validateCardInput(await readJsonBody(c), networks)
  if (!result.ok) throw ApiError.validation(result.errors)

  const card = await createCard(c.env.DB, result.value, idByCode)
  c.header('Location', `/v1/cards/${card.id}`)
  return c.json(toPublicCard(card), 201)
})

cardRoutes.patch('/:id', adminAuth, async (c) => {
  const { networks, idByCode } = await networkContext(c.env.DB)

  const result = validateCardPatch(await readJsonBody(c), networks)
  if (!result.ok) throw ApiError.validation(result.errors)

  return c.json(
    toPublicCard(await updateCard(c.env.DB, c.req.param('id'), result.value, idByCode)),
  )
})
```

- [ ] **Step 8: Update the pure validator tests**

In `backend/test/validate.test.ts`, the `validateCardInput` / `validateCardPatch` calls now need a second argument. Add this fixture near the top of the file and pass it at every call site:

```ts
import type { NetworkForValidation } from '../src/modules/networks/queries'

/**
 * Stands in for what listNetworksForValidation returns. Includes an inactive
 * and a ruleless network, because those are distinct rejections.
 */
const NETWORKS: NetworkForValidation[] = [
  { id: 'network_'.padEnd(40, 'a'), code: 'visa', isActive: true, binRules: [{ kind: 'glob', value: '4*' }] },
  { id: 'network_'.padEnd(40, 'b'), code: 'rupay', isActive: true, binRules: [{ kind: 'glob', value: '6[05]*' }] },
  { id: 'network_'.padEnd(40, 'c'), code: 'retired', isActive: false, binRules: [{ kind: 'glob', value: '9*' }] },
  { id: 'network_'.padEnd(40, 'd'), code: 'ruleless', isActive: true, binRules: [] },
]
```

Then add a describe block for the new rejections:

```ts
describe('validateCardInput networks', () => {
  const card = (networks: unknown) => ({
    bankId: 'bank_'.padEnd(37, 'a'),
    name: 'Test',
    country: 'IN',
    networks,
  })

  const errorsFor = (networks: unknown): string[] => {
    const result = validateCardInput(card(networks), NETWORKS)
    return result.ok ? [] : result.errors
  }

  it('accepts a network with a matching bin', () => {
    const result = validateCardInput(card([{ code: 'visa', bins: ['412345'] }]), NETWORKS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.networks).toEqual([{ code: 'visa', bins: ['412345'] }])
  })

  it('accepts an empty networks array as "on no networks"', () => {
    const result = validateCardInput(card([]), NETWORKS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.networks).toEqual([])
  })

  it('defaults a missing bins list to empty', () => {
    const result = validateCardInput(card([{ code: 'visa' }]), NETWORKS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.networks).toEqual([{ code: 'visa', bins: [] }])
  })

  it('normalises a code to lowercase', () => {
    const result = validateCardInput(card([{ code: 'VISA', bins: [] }]), NETWORKS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.networks).toEqual([{ code: 'visa', bins: [] }])
  })

  it('de-duplicates a repeated bin within one network', () => {
    const result = validateCardInput(
      card([{ code: 'visa', bins: ['412345', '412345'] }]),
      NETWORKS,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.networks).toEqual([{ code: 'visa', bins: ['412345'] }])
  })

  it('reports an unknown code', () => {
    expect(errorsFor([{ code: 'switch' }]).join(' ')).toMatch(/'switch' is not a known network/)
  })

  it('reports an inactive network', () => {
    expect(errorsFor([{ code: 'retired' }]).join(' ')).toMatch(/'retired' is not active/)
  })

  it('reports a network with no rules once bins are given', () => {
    expect(errorsFor([{ code: 'ruleless', bins: ['912345'] }]).join(' ')).toMatch(
      /has no BIN rules on file/,
    )
  })

  it('allows a ruleless network with no bins', () => {
    expect(validateCardInput(card([{ code: 'ruleless' }]), NETWORKS).ok).toBe(true)
  })

  it('reports a bin that fails its network rules', () => {
    expect(errorsFor([{ code: 'visa', bins: ['512345'] }]).join(' ')).toMatch(
      /BIN '512345' is not valid for network 'visa'/,
    )
  })

  it('reports a bin of the wrong length', () => {
    expect(errorsFor([{ code: 'visa', bins: ['4123'] }]).join(' ')).toMatch(/6 or 8 digits/)
  })

  it('reports a repeated network', () => {
    expect(errorsFor([{ code: 'visa' }, { code: 'visa' }]).join(' ')).toMatch(/listed twice/)
  })

  it('reports one bin claimed by two networks', () => {
    expect(
      errorsFor([
        { code: 'visa', bins: ['412345'] },
        { code: 'rupay', bins: ['412345'] },
      ]).join(' '),
    ).toMatch(/more than one network/)
  })

  it('reports a non-object network entry', () => {
    expect(errorsFor(['visa']).join(' ')).toMatch(/must be an object/)
  })

  it('reports a non-array networks field', () => {
    expect(errorsFor('visa').join(' ')).toMatch(/networks must be an array/)
  })
})
```

- [ ] **Step 9: Run the tests**

Run: `cd backend && npx vitest run test/validate.test.ts test/cardsWrite.test.ts`
Expected: PASS.

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 10: Typecheck and commit**

```bash
cd backend && npm run typecheck
```

```bash
git add backend/src/modules/cards backend/test/cardsWrite.test.ts backend/test/validate.test.ts
git commit -m "feat(cards): write networks and BIN prefixes together

networks: [\"visa\"] becomes networks: [{ code, bins }], so one POST creates
a complete card -- which is what the admin panel needs. Breaking, and
deliberately not extended to accept both shapes: the only consumers are our
own seeds and the panel.

Two behaviour changes fall out. The 409 refusing to drop a network that
still had BIN prefixes is gone, because the caller now states both halves
and there is no unmentioned data to protect. And networks: [] is now legal,
meaning 'on no networks' -- an admin editing a card they got wrong needs a
way back to empty.

Statement order in replaceNetworks is load-bearing: BINs are deleted first
to free the composite FK, then networks, then networks are inserted before
their BINs.

NETWORK_CODES is deleted. Network codes are data, so there is no
compile-time union left to keep in step with the database."
```

---

### Task 5: BIN-gated discovery and deactivated banks

**Files:**
- Modify: `backend/src/modules/cards/cardTypes.ts:120-130`
- Modify: `backend/src/modules/cards/queries.ts:104-142`
- Modify: `backend/src/modules/cards/routes.ts:27-41`
- Modify: `backend/src/modules/banks/routes.ts:36-41`
- Modify: `backend/src/modules/wallet/queries.ts:45-50`
- Modify: `backend/src/modules/wallet/routes.ts:40-45,129-134`
- Create: `backend/test/cardsGating.test.ts`
- Modify: `backend/test/cardsRead.test.ts:16,26,33,38,44,81`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CardFilters.includeUnselectable: boolean` — a required field, so every one of the six `listCards` call sites has to state its intent rather than inherit a default.

- [ ] **Step 1: Write the failing gating tests in their own file**

These tests create banks and cards, so they must **not** go in `cardsRead.test.ts`. That file's header states the rule: storage isolation is per test *file*, it asserts exact seeded counts (`SEEDED_BANKS = 12`, `SEEDED_CARDS = 100`), and writes there would leak into those counts. It also has no admin-token helper — its `get()` sends no `Authorization` header at all.

Create `backend/test/cardsGating.test.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The BIN visibility gate and the bank-active gate. Its own file because these
 * tests write, and cardsRead.test.ts asserts exact seeded counts.
 */

const base = 'http://api.test'
const AUTH = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }

function send(method: string, path: string, body?: unknown) {
  return SELF.fetch(`${base}${path}`, {
    method,
    headers: AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function json(res: Response) {
  return (await res.json()) as any
}

/**
 * A card with no BIN prefixes cannot be verified, so it is not offered. The
 * rule is discovery-scoped, NOT resolution-scoped: four call sites resolve
 * wallets through listCards({ ids }), and gating those would take cards out of
 * wallets people already hold -- including via the prune listener in
 * frontend/src/store/store.ts, which deletes any picked card the catalog stops
 * returning.
 */
describe('BIN-gated discovery', () => {
  let gatedId = ''
  let bankId = ''

  beforeAll(async () => {
    bankId = (await json(await send('POST', '/v1/banks', { name: 'Gate Bank' }))).id
    gatedId = (
      await json(
        await send('POST', '/v1/cards', {
          bankId,
          name: 'No Bins Card',
          country: 'IN',
          networks: [{ code: 'visa', bins: [] }],
        }),
      )
    ).id
  })

  it('hides a card with no bins from the browse list', async () => {
    const body = await json(await send('GET', '/v1/cards?limit=100'))
    expect(body.data.some((c: any) => c.id === gatedId)).toBe(false)
  })

  it('hides it from a search too', async () => {
    const body = await json(await send('GET', '/v1/cards?q=No%20Bins'))
    expect(body.data).toHaveLength(0)
    expect(body.total).toBe(0)
  })

  it('still resolves it by explicit ids, so wallets survive', async () => {
    const body = await json(await send('GET', `/v1/cards?ids=${gatedId}`))
    expect(body.data.map((c: any) => c.id)).toEqual([gatedId])
  })

  it('still serves it by its own id', async () => {
    const res = await send('GET', `/v1/cards/${gatedId}`)
    expect(res.status).toBe(200)
    expect((await json(res)).id).toBe(gatedId)
  })

  it('shows it when includeUnselectable is set, so an admin can fix it', async () => {
    const body = await json(await send('GET', '/v1/cards?includeUnselectable=true&limit=100'))
    expect(body.data.some((c: any) => c.id === gatedId)).toBe(true)
  })

  it('still scores a wallet holding it', async () => {
    const res = await send('POST', '/v1/wallet/preview', { cardIds: [gatedId] })
    expect(res.status).toBe(200)

    const body = await json(res)
    expect(body.cardCount).toBe(1)
    // The real assertion: unknownIds is what a client prunes from, so a gated
    // card landing there is exactly the wallet-eating bug this carve-out exists
    // to prevent.
    expect(body.unknownIds).toEqual([])
  })

  it('shows a card once it gains a bin', async () => {
    await send('PATCH', `/v1/cards/${gatedId}`, {
      networks: [{ code: 'visa', bins: ['412399'] }],
    })
    const body = await json(await send('GET', '/v1/cards?q=No%20Bins'))
    expect(body.data.map((c: any) => c.id)).toEqual([gatedId])
  })
})

describe('deactivated banks', () => {
  it('hides a deactivated bank\'s cards but keeps resolving them', async () => {
    const bank = await json(await send('POST', '/v1/banks', { name: 'Doomed Bank' }))
    const card = await json(
      await send('POST', '/v1/cards', {
        bankId: bank.id,
        name: 'Doomed Card',
        country: 'IN',
        networks: [{ code: 'visa', bins: ['412388'] }],
      }),
    )

    expect((await json(await send('GET', '/v1/cards?q=Doomed'))).total).toBe(1)

    expect((await send('DELETE', `/v1/banks/${bank.id}`)).status).toBe(204)

    expect((await json(await send('GET', '/v1/cards?q=Doomed'))).total).toBe(0)
    expect(
      (await json(await send('GET', '/v1/cards?q=Doomed&includeInactive=true'))).total,
    ).toBe(1)
    expect(
      (await json(await send('GET', `/v1/cards?ids=${card.id}`))).data.map((c: any) => c.id),
    ).toEqual([card.id])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/cardsGating.test.ts`
Expected: FAIL — the gated card appears in the browse list, and the deactivated bank's card still counts 1.

- [ ] **Step 3: Add the filter field**

In `backend/src/modules/cards/cardTypes.ts`, add to `CardFilters`:

```ts
export type CardFilters = {
  q?: string
  bankId?: string
  network?: string
  country?: string
  maxAnnualFee?: number
  ids?: string[]
  includeInactive: boolean
  /**
   * Lets a caller see cards with no BIN prefixes, which browse and search hide.
   * Required rather than optional so every call site states its intent: getting
   * this wrong takes cards out of people's wallets.
   */
  includeUnselectable: boolean
  limit: number
  offset: number
}
```

- [ ] **Step 4: Apply both gates in `buildWhere`**

In `backend/src/modules/cards/queries.ts`, replace line 111 and add the BIN gate after the `ids` branch:

```ts
  if (!f.includeInactive) {
    conds.push('c.is_active = 1')
    // A retired issuer takes its cards with it. Without this, deactivating a
    // bank left every one of its cards in the catalog.
    conds.push('b.is_active = 1')
  }
```

...and immediately before the closing `return`:

```ts
  /*
   * A card with no BIN prefixes cannot be verified, so it is not offered.
   *
   * Discovery-scoped, and the `!f.ids` is the whole point: an explicit ids=
   * lookup is resolving cards someone already holds, and four call sites do
   * exactly that -- getWallet, /wallet/preview, knownCardIds and the stored
   * wallet read. Gating them would drop held cards from a wallet and change its
   * score, and the prune listener in frontend/src/store/store.ts would then
   * delete them from the browser's copy for good.
   */
  if (!f.includeUnselectable && !f.ids) {
    conds.push('EXISTS (SELECT 1 FROM card_bins cb WHERE cb.card_id = c.id)')
  }
```

- [ ] **Step 5: State the intent at all six call sites**

`backend/src/modules/cards/routes.ts:27-41` — the browse list is the gate's reason for existing:

```ts
    includeInactive: parseBool(c.req.query('includeInactive')),
    includeUnselectable: parseBool(c.req.query('includeUnselectable')),
```

`backend/src/modules/banks/routes.ts:36-41` — a bank's cards is also discovery:

```ts
    includeInactive: parseBool(c.req.query('includeInactive')),
    includeUnselectable: parseBool(c.req.query('includeUnselectable')),
```

`backend/src/modules/wallet/queries.ts:45-50`, `backend/src/modules/wallet/routes.ts:40-45` and `backend/src/modules/wallet/routes.ts:129-134` — all three resolve known ids, so all three opt out explicitly:

```ts
    ids,
    includeInactive: true,
    // Resolution, not discovery: a card already in a wallet must resolve even
    // with no BIN prefixes on file.
    includeUnselectable: true,
```

- [ ] **Step 6: Repair the seeded-catalog assertions the gate moves**

The gate takes the browse catalog from 100 cards to 33, which breaks `cardsRead.test.ts` in two distinct ways. Both are real regressions in the test file, not in the code.

**a. The `cardNamed` helper.** It looks a card up through `GET /v1/cards?q=…`, which is gated, so it returns `undefined` for any card without BINs — a `TypeError` rather than a clean failure. Verified against the seed: `Infinia Metal` and `Pioneer Legacy` have BINs, but **`Centurion Charge Card` and both `Tata Neu Infinity` rows do not**, so three tests break this way.

Those tests assert fees, ids and response shape — not discoverability — so the helper should opt out of the gate. Change line 26:

```ts
/**
 * The seed mints random ids, so tests look cards up by name.
 *
 * includeUnselectable, because these lookups are about a card's data, not
 * whether it is offered: only 33 of the 100 seeded cards have BIN prefixes, and
 * Centurion Charge Card and Tata Neu Infinity are among those that do not.
 */
async function cardNamed(name: string) {
  const { body } = await get(
    `/v1/cards?q=${encodeURIComponent(name)}&includeUnselectable=true&limit=100`,
  )
  return body.data.find((card: any) => card.name === name)
}
```

**b. The three exact count assertions.** Add a second constant beside `SEEDED_CARDS` at line 16:

```ts
const SEEDED_BANKS = 12
const SEEDED_CARDS = 100
/**
 * What browse and search return: 0010 gives BIN prefixes to 33 of the 100
 * cards, and a card with none is not selectable. The other 67 are still
 * reachable by id and with ?includeUnselectable=true.
 */
const SEEDED_SELECTABLE_CARDS = 33
const SEEDED_CRITERIA = 7
```

Then fix each site. Line 33 asserts the ungated total, so it becomes the gated one:

```ts
    expect((await get('/v1/cards')).body.total).toBe(SEEDED_SELECTABLE_CARDS)
```

Line 38 (`gives every card a bank`) and line 81 (`omits the rating from every card in a list`) both page with `?limit=100` and assert `toHaveLength(SEEDED_CARDS)`. Their subject is every card, so keep the subject and drop the gate:

```ts
    const { body } = await get('/v1/cards?includeUnselectable=true&limit=100')
    expect(body.data).toHaveLength(SEEDED_CARDS)
```

Line 44 (`mints seeded ids in the same shape the API does`) asserts `every(...)` with no length check, so it passes either way — but give it `includeUnselectable=true` too, so it actually covers all 100 ids rather than 33.

Add one test asserting the gate holds on the seeded catalog, which is the claim the two constants now encode:

```ts
  it('offers only the cards that have BIN prefixes', async () => {
    expect((await get('/v1/cards')).body.total).toBe(SEEDED_SELECTABLE_CARDS)
    expect((await get('/v1/cards?includeUnselectable=true')).body.total).toBe(SEEDED_CARDS)
  })
```

- [ ] **Step 7: Run the tests**

Run: `cd backend && npx vitest run test/cardsGating.test.ts test/cardsRead.test.ts`
Expected: PASS.

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

```bash
cd backend && npm run typecheck
```

```bash
git add backend/src/modules backend/test/cardsGating.test.ts backend/test/cardsRead.test.ts
git commit -m "feat(cards): hide cards with no BIN prefixes from discovery

A card with no BINs cannot be verified, so it is not offered. The rule is
discovery-scoped, not resolution-scoped, and that distinction is the whole
design: getWallet, /wallet/preview, knownCardIds and the stored wallet read
all resolve through listCards({ ids }), so gating them would drop held cards
from a wallet and change its score -- and the prune listener in
frontend/src/store/store.ts would then delete them from the browser's copy
permanently.

?includeUnselectable=true is the admin's way in, since a card needs to be
findable to be fixed.

Also fixes a pre-existing bug the same query owns: buildWhere checked
c.is_active but never b.is_active, so deactivating a bank left all its cards
in the catalog.

includeUnselectable is a required field on CardFilters rather than an
optional one, so all six call sites state their intent.

cardsRead.test.ts needed repair, not just a new number: its cardNamed
helper searches through the gated endpoint, and Centurion Charge Card and
Tata Neu Infinity have no BIN prefixes, so three tests were resolving
undefined. The helper now opts out of the gate -- those tests are about a
card's fees and shape, not whether it is offered."
```

---

### Task 6: `cards.type` on the API

The column landed in Task 1. This exposes it.

**Files:**
- Modify: `backend/src/modules/cards/cardTypes.ts`
- Modify: `backend/src/modules/cards/queries.ts:25-42,73-97,266-300,302-331`
- Modify: `backend/src/modules/cards/validate.ts`
- Modify: `backend/test/cardsWrite.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CARD_TYPES: readonly ['credit','debit','charge','prepaid']`; `type CardType`; `Card.type: CardType`; `CardInput.type?: CardType`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('POST /v1/cards', ...)` block in `backend/test/cardsWrite.test.ts`:

```ts
  it('defaults type to credit', async () => {
    const body = await json(await send('POST', '/v1/cards', card()))
    expect(body.type).toBe('credit')
  })

  it('stores an explicit type', async () => {
    const body = await json(await send('POST', '/v1/cards', card({ type: 'charge' })))
    expect(body.type).toBe('charge')
  })

  it('rejects an unknown type', async () => {
    const res = await send('POST', '/v1/cards', card({ type: 'loyalty' }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(/type must be one of/)
  })

  it('patches the type', async () => {
    const created = await json(await send('POST', '/v1/cards', card()))
    const res = await send('PATCH', `/v1/cards/${created.id}`, { type: 'debit' })
    expect(res.status).toBe(200)
    expect((await json(res)).type).toBe('debit')
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run test/cardsWrite.test.ts`
Expected: FAIL — `body.type` is `undefined`, and the unknown type is accepted.

- [ ] **Step 3: Add the type to `cardTypes.ts`**

```ts
/**
 * What kind of card this is. Mirrors the CHECK constraint in migration 0012 --
 * change one, change the other.
 *
 * Credit is the default and the whole of the launch catalog. The others exist
 * because the column may as well accept them: SQLite cannot widen a CHECK
 * without rebuilding the table, so the headroom is free now and expensive
 * later.
 */
export const CARD_TYPES = ['credit', 'debit', 'charge', 'prepaid'] as const

export type CardType = (typeof CARD_TYPES)[number]

export function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && (CARD_TYPES as readonly string[]).includes(value)
}
```

Add `type: CardType` to `Card` (after `country`), and `type?: CardType` to `CardInput`:

```ts
  /** 'credit' unless an admin said otherwise. */
  type?: CardType
```

- [ ] **Step 4: Carry it through the queries**

In `backend/src/modules/cards/queries.ts`: add `type: CardType` to `CardRow`; add `c.type` to `CARD_COLUMNS`; add `type: row.type` to `toCard`'s returned object; add the column and bind to `createCard`'s INSERT:

```ts
        `INSERT INTO cards (id, bank_id, name, country, type, joining_fee, annual_fee, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
```

```ts
      .bind(
        id,
        input.bankId,
        input.name,
        input.country,
        input.type ?? 'credit',
        input.joiningFee,
        input.annualFee,
        input.isActive === false ? 0 : 1,
      )
```

...and one line in `updateCard` beside the other `assign` calls:

```ts
  assign('type', patch.type)
```

- [ ] **Step 5: Validate it**

In `backend/src/modules/cards/validate.ts`, import `CARD_TYPES` and `isCardType` from `./cardTypes`, add the checker:

```ts
/** Overlaps the CHECK in migration 0012; this exists to produce a good 400. */
function checkCardType(value: unknown, errors: string[]): CardType | undefined {
  if (!isCardType(value)) {
    errors.push(`type must be one of ${CARD_TYPES.join(', ')}.`)
    return undefined
  }
  return value
}
```

In `validateCardInput`, after the `country` line:

```ts
  const type = body.type === undefined ? undefined : checkCardType(body.type, errors)
```

...and add `type,` to the returned value object. In `validateCardPatch`, beside the other optional fields:

```ts
  if (body.type !== undefined) patch.type = checkCardType(body.type, errors)
```

- [ ] **Step 6: Run the tests**

Run: `cd backend && npx vitest run test/cardsWrite.test.ts`
Expected: PASS.

Run: `cd backend && npm test`
Expected: PASS. A test asserting an exact card response shape with `toEqual` will need `type: 'credit'` added.

- [ ] **Step 7: Typecheck and commit**

```bash
cd backend && npm run typecheck
```

```bash
git add backend/src/modules/cards backend/test/cardsWrite.test.ts
git commit -m "feat(cards): expose cards.type, defaulting to credit

The column arrived with 0012. This serialises it on the card, accepts it on
POST and PATCH, and validates it against the same four values as the CHECK.

No read path filters on it: credit is the default and the entire seeded
catalog, so a ?type= filter would have nothing to do yet."
```

---

### Task 7: Documentation

**Files:**
- Modify: `backend/README.md:239-307`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Rewrite the "Networks and BINs" section**

Replace `backend/README.md` lines 239-267 (the section head through the `network` enum paragraph) with:

````markdown
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

The glob alphabet is restricted in both the `CHECK` on `network_bin_rules` and
in `isBinRuleValue`, which is what makes translating a glob straight to a
`RegExp` safe — no metacharacter reaches it.

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

The carve-out is not a convenience. Four call sites resolve wallets through
`listCards({ ids })`, so gating them would drop held cards from a wallet and
change its score — and the prune listener in `frontend/src/store/store.ts`
deletes any picked card the catalog stops returning, permanently, from the
browser's persisted copy.

Only 33 of the 100 seeded cards have BIN rows, so the browse catalog is 33 cards
until an admin backfills the rest. Wallets already holding the other 67 keep
them, keep their verification status, and keep scoring.

`GET /v1/cards?includeInactive=true` also now reveals cards whose *bank* was
deactivated. Before this, `buildWhere` checked `c.is_active` but never
`b.is_active`, so removing a bank left all its cards in the catalog.
````

Then, in the surviving `### How much a BIN actually tells you` subsection, change the sentence *"Consult `card_networks`; do not infer"* to name the join through `networks`, and delete the stale *"BINs themselves are seed-only; there is no endpoint for them yet"* claim wherever it survives.

- [ ] **Step 2: Verify no stale claim survives**

Run:

```bash
cd backend && grep -n "seed-only\|CHECK enum\|card_networks is the\|jcb\`, \`unionpay\` — the last three" README.md
```

Expected: no output. Any hit is a claim the refactor invalidated.

- [ ] **Step 3: Commit**

```bash
git add backend/README.md
git commit -m "docs: describe networks as tables and the BIN gate

Rewrites the Networks and BINs section: four tables instead of an enum,
/v1/networks as admin-only, networks and BINs written together on a card,
and why the prefix rules left SQL.

Documents the discovery-vs-resolution split on the BIN gate with the reason
it exists -- four call sites resolve wallets through listCards({ ids }) and
the frontend prune listener makes a wrong call permanent -- plus the
consequence: 33 browsable cards until BINs are backfilled.

Drops the 'BINs are seed-only' claim, which POST /v1/cards now falsifies."
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: schema → 1; `0010` reseed → 1; `0012` → 1 and 6; BIN gate table → 5; deactivated banks → 5; `/v1/networks` → 3; nested card writes → 4; validation and its seven error messages → 2 and 4; frontend (no change) → asserted by the green suite in 5; testing table → spread across 1–6; sequence → task order; README → 7.

**Two deliberate deviations from the spec, both noted at their task:** the matcher's unit tests live in `test/binRules.test.ts` rather than `validate.test.ts`, because they have no request in them; and the spec's `verification.test.ts` row needs no new work — Task 1 keeps `listCardNetworks`'s signature and return shape identical, so the existing tests cover the `network_id` change, and the "networks but no BINs cannot start a verification" case is already tested against `routes.ts:72-77`.

**One consequence worth restating.** Because the BIN gate exempts `ids=`, `knownCardIds` still admits a BIN-less card, so `POST /v1/wallet/cards/:id` can add one directly. That is intended — it is what keeps sign-in merge working for wallets holding the other 67 cards — but it does mean the gate is a UI-discovery rule, not an authorization rule.

**Verified against the live seed rather than assumed**, because the first draft of Task 5 was wrong on both counts:

- `cardsRead.test.ts` is reads-only by contract (per-file storage isolation, exact seeded counts), so the gating tests moved to their own `cardsGating.test.ts`. The first draft appended them there and would have broken `SEEDED_BANKS`/`SEEDED_CARDS`.
- The gate's blast radius is wider than the count assertions. `cardNamed()` searches through the gated endpoint, and a query against the local D1 confirms `Centurion Charge Card` and both `Tata Neu Infinity` rows have no BIN prefixes — so three tests would have thrown a `TypeError` on `undefined`, not failed an assertion. `Infinia Metal` and `Pioneer Legacy` do have prefixes. 33 of 100 cards have BIN rows, matching Task 1's assertion.

Also confirmed rather than assumed: `POST /v1/wallet/preview` takes `{ cardIds }` (`wallet/validate.ts:17`) and returns `WalletScore` unwrapped, so `cardCount` and `unknownIds` are top-level (`wallet/walletTypes.ts:51-58`).

**Type consistency, checked across tasks:** `BinRule`/`BinRuleKind` (2 → 3, 4); `matchesBinRules` (2 → 4); `NetworkForValidation` and `listNetworksForValidation` (3 → 4); `CardNetworkInput` (4, used in `cardTypes`, `validate`, `queries`); `idByCode: Map<string, string>` (4, routes → queries); `includeUnselectable` (5, all six call sites); `CardType`/`CARD_TYPES`/`isCardType` (6). `NETWORK_CODES`, `NetworkCode` and `isNetworkCode` are deleted in Task 4 and referenced nowhere after it — Task 1's `listCardNetworks` annotation is the last user, and Step 3 of Task 4 removes it.
