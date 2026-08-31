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
