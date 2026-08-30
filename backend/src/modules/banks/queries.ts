import { ApiError } from '../../http/errors'
import { likePattern } from '../../http/params'
import { generateBankId } from './bankTypes'
import type { Bank, BankFilters, BankInput, BankPatch } from './bankTypes'

type BankRow = {
  id: string
  name: string
  is_active: number
}

const BANK_COLUMNS = 'id, name, is_active'
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"

function toBank(row: BankRow): Bank {
  return { id: row.id, name: row.name, isActive: row.is_active === 1 }
}

function buildWhere(f: BankFilters): { clause: string; binds: unknown[] } {
  const conds: string[] = []
  const binds: unknown[] = []

  if (!f.includeInactive) conds.push('is_active = 1')
  if (f.q) {
    conds.push("name LIKE ? ESCAPE '\\'")
    binds.push(likePattern(f.q))
  }

  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', binds }
}

export async function listBanks(
  db: D1Database,
  filters: BankFilters,
): Promise<{ banks: Bank[]; total: number }> {
  const { clause, binds } = buildWhere(filters)

  const [page, count] = await db.batch<BankRow & { total: number }>([
    db
      .prepare(`SELECT ${BANK_COLUMNS} FROM banks ${clause} ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?`)
      .bind(...binds, filters.limit, filters.offset),
    db.prepare(`SELECT COUNT(*) AS total FROM banks ${clause}`).bind(...binds),
  ])

  return {
    banks: (page.results as BankRow[]).map(toBank),
    total: count.results[0]?.total ?? 0,
  }
}

export async function getBank(db: D1Database, id: string): Promise<Bank | null> {
  const row = await db
    .prepare(`SELECT ${BANK_COLUMNS} FROM banks WHERE id = ?`)
    .bind(id)
    .first<BankRow>()
  return row ? toBank(row) : null
}

export async function bankExists(db: D1Database, id: string): Promise<boolean> {
  const found = await db.prepare('SELECT 1 FROM banks WHERE id = ?').bind(id).first()
  return found !== null
}

async function requireBank(db: D1Database, id: string): Promise<void> {
  if (!(await bankExists(db, id))) throw ApiError.notFound(`Bank '${id}'`)
}

export async function createBank(db: D1Database, input: BankInput): Promise<Bank> {
  const id = generateBankId()

  try {
    await db
      .prepare('INSERT INTO banks (id, name, is_active) VALUES (?, ?, ?)')
      .bind(id, input.name, input.isActive === false ? 0 : 1)
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict(`A bank named '${input.name}' already exists.`)
    }
    throw err
  }

  const bank = await getBank(db, id)
  if (!bank) throw new Error(`Bank '${id}' vanished immediately after insert`)
  return bank
}

export async function updateBank(db: D1Database, id: string, patch: BankPatch): Promise<Bank> {
  await requireBank(db, id)

  const sets: string[] = []
  const binds: unknown[] = []
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
      await db.prepare(`UPDATE banks SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run()
    } catch (err) {
      if (isUniqueViolation(err)) throw ApiError.conflict('Another bank already uses that name.')
      throw err
    }
  }

  const bank = await getBank(db, id)
  if (!bank) throw ApiError.notFound(`Bank '${id}'`)
  return bank
}

/**
 * Soft delete only. Cards hold a foreign key to banks, so a hard delete would
 * either fail or orphan the catalog; deactivating keeps both intact.
 */
export async function deactivateBank(db: D1Database, id: string): Promise<void> {
  await requireBank(db, id)
  await db.prepare(`UPDATE banks SET is_active = 0, updated_at = ${NOW} WHERE id = ?`).bind(id).run()
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}
