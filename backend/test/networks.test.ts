import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { NETWORK_ID_PATTERN } from '../src/modules/networks/networkTypes'

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

    // 114 from 0010, two from 0017 so AURUM can be proved on Mastercard and
    // IndianOil on RuPay, and ten from 0018's six inactive cards.
    const pairs = await env.DB.prepare('SELECT COUNT(*) AS n FROM card_networks').first<{ n: number }>()
    expect(pairs?.n).toBe(126)
  })

  it('keeps all 114 seeded BIN prefixes across 40 cards', async () => {
    // 99 from 0010, four from 0017, and eleven from 0018 -- together every
    // BookMyShow prefix that names exactly one product this catalog carries.
    const bins = await env.DB.prepare('SELECT COUNT(*) AS n FROM card_bins').first<{ n: number }>()
    expect(bins?.n).toBe(114)

    // 33, plus Axis IndianOil from 0017 and 0018's six -- which hold prefixes
    // while sitting inactive, so nothing can pick them up until they are scored.
    const carded = await env.DB.prepare(
      'SELECT COUNT(DISTINCT card_id) AS n FROM card_bins',
    ).first<{ n: number }>()
    expect(carded?.n).toBe(40)
  })

  it('defaults every seeded card to type credit', async () => {
    const other = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cards WHERE type <> 'credit'",
    ).first<{ n: number }>()
    expect(other?.n).toBe(0)
  })
})

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

  it('rejects a structurally malformed glob', async () => {
    const res = await send('POST', '/v1/networks', network({
      binRules: [{ kind: 'glob', value: '4[' }],
    }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(/must be digits/)
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
   * The one public read is `/options`, covered below -- it publishes the code
   * and name a card-request form needs and nothing this list would expose.
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

describe('GET /v1/networks/options', () => {
  it('is public, unlike every other read on this resource', async () => {
    const res = await SELF.fetch(`${base}/v1/networks/options`)
    expect(res.status).toBe(200)
  })

  it('publishes the code and the name, and nothing else', async () => {
    const body = (await (await SELF.fetch(`${base}/v1/networks/options`)).json()) as any

    expect(body.data.length).toBeGreaterThan(0)
    for (const option of body.data) {
      // Not the id, which never leaves the server, and not binRules, which is
      // the list a card verification matches against.
      expect(Object.keys(option).sort()).toEqual(['code', 'name'])
    }
    expect(body.data.map((n: any) => n.code)).toContain('visa')
  })

  it('leaves a retired network out', async () => {
    const created = (await (
      await SELF.fetch(`${base}/v1/networks`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ code: 'optionsgone', name: 'Options Gone', binRules: [{ kind: 'glob', value: '7*' }] }),
      })
    ).json()) as any
    await SELF.fetch(`${base}/v1/networks/${created.id}`, { method: 'DELETE', headers: AUTH })

    const body = (await (await SELF.fetch(`${base}/v1/networks/options`)).json()) as any
    expect(body.data.map((n: any) => n.code)).not.toContain('optionsgone')
  })
})
