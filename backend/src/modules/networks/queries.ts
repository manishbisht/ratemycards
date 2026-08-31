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
