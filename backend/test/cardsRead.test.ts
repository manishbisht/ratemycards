import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { generateCardId } from '../src/modules/cards/cardTypes'
import { listCards } from '../src/modules/cards/queries'

/**
 * Reads only, asserted against the seeded catalog -- so this file doubles as
 * the seed's regression test. Storage isolation is per test FILE, not per test,
 * so anything that writes lives in the write test files; its rows would
 * otherwise leak into the counts asserted here.
 */

const base = 'http://api.test'

const SEEDED_BANKS = 12
const SEEDED_CARDS = 100
const SEEDED_CRITERIA = 7

/**
 * Every read in this file opts out of the BIN visibility gate.
 *
 * This file's subject is the seeded catalog -- its own header calls it the
 * seed's regression test -- not which cards happen to be offered. Only 33 of
 * the 100 seeded cards carry BIN prefixes, so without this the gate would
 * quietly shrink every count here, and cardNamed() would return undefined for
 * Centurion Charge Card and Tata Neu Infinity, which have none. The gate's own
 * behaviour is covered by cardsGating.test.ts.
 */
async function get(path: string) {
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}includeUnselectable=true`
  const res = await SELF.fetch(url)
  return { res, body: (await res.json()) as any }
}

/** The seed mints random ids, so tests look cards up by name. */
async function cardNamed(name: string) {
  const { body } = await get(`/v1/cards?q=${encodeURIComponent(name)}&limit=100`)
  return body.data.find((card: any) => card.name === name)
}

describe('the seeded catalog', () => {
  it('has every bank, card, and criterion', async () => {
    expect((await get('/v1/banks')).body.total).toBe(SEEDED_BANKS)
    expect((await get('/v1/cards')).body.total).toBe(SEEDED_CARDS)
    expect((await get('/v1/criteria')).body.total).toBe(SEEDED_CRITERIA)
  })

  it('gives every card a bank', async () => {
    const { body } = await get('/v1/cards?limit=100')
    expect(body.data).toHaveLength(SEEDED_CARDS)
    expect(body.data.every((card: any) => card.bank?.id && card.bank?.name)).toBe(true)
  })

  it('mints seeded ids in the same shape the API does', async () => {
    const { body } = await get('/v1/cards?limit=100')
    expect(body.data.every((card: any) => /^card_[0-9a-f]{32}$/.test(card.id))).toBe(true)
    expect(body.data.every((card: any) => /^bank_[0-9a-f]{32}$/.test(card.bank.id))).toBe(true)
  })

  it('carries the published fees', async () => {
    const infinia = await cardNamed('Infinia Metal')
    expect(infinia.bank.name).toBe('HDFC')
    expect(infinia.joiningFee).toBe(12500)
    expect(infinia.annualFee).toBe(12500)
  })

  it('keeps a joining fee and an annual fee independent', async () => {
    // Pioneer Legacy costs 50,000 to join and nothing to hold.
    const legacy = await cardNamed('Pioneer Legacy')
    expect(legacy.joiningFee).toBe(50000)
    expect(legacy.annualFee).toBe(0)
  })

  it('handles the most expensive card in the catalog', async () => {
    const centurion = await cardNamed('Centurion Charge Card')
    expect(centurion.joiningFee).toBe(700000)
    expect(centurion.annualFee).toBe(275000)
  })

  it('allows the same card name at two different banks', async () => {
    const { body } = await get('/v1/cards?q=Tata%20Neu%20Infinity&limit=100')
    const banks = body.data
      .filter((card: any) => card.name === 'Tata Neu Infinity')
      .map((card: any) => card.bank.name)
      .sort()
    expect(banks).toEqual(['HDFC', 'SBI'])
  })

  it('offers only the cards that carry BIN prefixes', async () => {
    // Bypasses the helper above on purpose, to see the ungated default.
    const gated = await SELF.fetch(`${base}/v1/cards`)
    expect(((await gated.json()) as any).total).toBe(33)
    expect((await get('/v1/cards')).body.total).toBe(SEEDED_CARDS)
  })
})

describe('ratings stay off the public API', () => {
  it('omits the rating from every card in a list', async () => {
    const { body } = await get('/v1/cards?limit=100')
    expect(body.data).toHaveLength(SEEDED_CARDS)
    expect(body.data.some((card: any) => 'rating' in card)).toBe(false)
  })

  it('omits the rating from a single card', async () => {
    const infinia = await cardNamed('Infinia Metal')
    expect('rating' in infinia).toBe(false)
  })

  it('omits the rating from a bank\'s cards', async () => {
    const bank = (await get('/v1/banks?q=HDFC')).body.data[0]
    const { body } = await get(`/v1/banks/${bank.id}/cards?limit=100`)
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.data.some((card: any) => 'rating' in card)).toBe(false)
  })

  it('leaks no score-shaped field under any other name', async () => {
    const infinia = await cardNamed('Infinia Metal')
    expect(Object.keys(infinia).some((k) => /rating|score|weight|criteri/i.test(k))).toBe(false)
  })

  it('requires the admin token for the raw score breakdown', async () => {
    const infinia = await cardNamed('Infinia Metal')
    const res = await SELF.fetch(`${base}/v1/cards/${infinia.id}/scores`)
    expect(res.status).toBe(401)
  })
})

describe('the seeded rubric', () => {
  it('weights sum to 100', async () => {
    const { body } = await get('/v1/criteria?limit=100')
    const total = body.data.reduce((sum: number, c: any) => sum + c.weight, 0)
    expect(total).toBe(100)
  })

  it('orders heaviest first and describes what each measures', async () => {
    const { body } = await get('/v1/criteria?limit=100')
    expect(body.data.map((c: any) => [c.name, c.weight])).toEqual([
      ['Rewards / Returns', 30],
      ['Travel Benefits', 20],
      ['Exclusivity / Prestige', 15],
      ['Lifestyle Benefits', 15],
      ['Milestone / Welcome Benefits', 10],
      ['Fees vs Value', 5],
      ['Forex / International', 5],
    ])
    expect(body.data[0].description).toBe('Effective reward rate and redemption value')
  })
})

describe('GET /v1/cards', () => {
  it('exposes exactly the documented fields', async () => {
    const { body } = await get('/v1/cards?limit=1')
    expect(Object.keys(body.data[0]).sort()).toEqual([
      'annualFee',
      'bank',
      'country',
      'id',
      'isActive',
      'issuer',
      'joiningFee',
      'name',
      'selectable',
      'type',
    ])
  })

  it('echoes the bank name as issuer', async () => {
    const infinia = await cardNamed('Infinia Metal')
    expect(infinia.issuer).toBe(infinia.bank.name)
  })

  it('sorts case-insensitively, so lowercase names are not exiled to the end', async () => {
    const { body } = await get('/v1/cards?q=AU&limit=100')
    const auCards = body.data.filter((card: any) => card.bank.name === 'AU')
    expect(auCards.map((card: any) => card.name)).toEqual([
      'Altura Plus',
      'ixigo',
      'LIT',
      'Vetta',
      'Zenith',
      'Zenith+',
    ])
  })

  it('paginates without losing the total', async () => {
    const { body } = await get('/v1/cards?limit=10&offset=90')
    expect(body.data).toHaveLength(10)
    expect(body.total).toBe(SEEDED_CARDS)
  })

  it('caps the page size', async () => {
    const { body } = await get('/v1/cards?limit=9999')
    expect(body.data).toHaveLength(100)
  })
})

describe('search', () => {
  it('matches on card name', async () => {
    const { body } = await get('/v1/cards?q=infinia')
    expect(body.data.map((card: any) => card.name)).toEqual(['Infinia Metal'])
  })

  it('matches on the bank name across the join', async () => {
    const { body } = await get('/v1/cards?q=axis&limit=100')
    expect(body.total).toBe(17)
    expect(body.data.every((card: any) => card.bank.name === 'Axis')).toBe(true)
  })

  it('is case insensitive', async () => {
    expect((await get('/v1/cards?q=INFINIA')).body.total).toBe(1)
  })

  // Unescaped, '%' would match all 100 rows and turn search into a catalog dump.
  it('treats % as a literal, not a wildcard', async () => {
    expect((await get('/v1/cards?q=%25')).body.total).toBe(0)
  })

  it('treats _ as a literal, not a wildcard', async () => {
    expect((await get('/v1/cards?q=_')).body.total).toBe(0)
  })

  it('survives a trailing backslash', async () => {
    const { res, body } = await get('/v1/cards?q=%5C')
    expect(res.status).toBe(200)
    expect(body.total).toBe(0)
  })

  it('finds a card whose name contains a plus sign', async () => {
    const { body } = await get('/v1/cards?q=Power%2B')
    expect(body.data.map((card: any) => card.name)).toEqual(['Power+'])
  })
})

describe('filters', () => {
  it('filters by bankId', async () => {
    const banks = (await get('/v1/banks?q=Axis')).body.data
    const { body } = await get(`/v1/cards?bankId=${banks[0].id}&limit=100`)
    expect(body.total).toBe(17)
  })

  it('filters by annual fee ceiling', async () => {
    expect((await get('/v1/cards?maxAnnualFee=0')).body.total).toBe(11)
    expect((await get('/v1/cards?maxAnnualFee=500&limit=100')).body.total).toBe(32)
  })

  it('ignores a junk fee filter rather than erroring', async () => {
    expect((await get('/v1/cards?maxAnnualFee=abc')).body.total).toBe(SEEDED_CARDS)
  })

  it('filters by country', async () => {
    expect((await get('/v1/cards?country=in')).body.total).toBe(SEEDED_CARDS)
    expect((await get('/v1/cards?country=US')).body.total).toBe(0)
  })

  it('returns the requested subset for ids, skipping unknown ones', async () => {
    const { body } = await get('/v1/cards?limit=2')
    const ids = body.data.map((card: any) => card.id)
    const subset = await get(`/v1/cards?ids=${ids.join(',')},card_deadbeef`)
    expect(subset.body.total).toBe(2)
  })

  it('returns nothing for an explicitly empty ids list', async () => {
    const { body } = await get('/v1/cards?ids=')
    expect(body.total).toBe(0)
    expect(body.data).toEqual([])
  })

  it('caps ids well under the D1 bound-parameter limit', async () => {
    const many = Array.from({ length: 80 }, () => generateCardId()).join(',')
    expect((await get(`/v1/cards?ids=${many}`)).res.status).toBe(200)
  })
})

describe('GET /v1/banks/:id/cards', () => {
  it("returns only that bank's cards", async () => {
    const bank = (await get('/v1/banks?q=IndusInd')).body.data[0]
    const { res, body } = await get(`/v1/banks/${bank.id}/cards?limit=100`)
    expect(res.status).toBe(200)
    expect(body.total).toBe(9)
    expect(body.data.every((card: any) => card.bank.name === 'IndusInd')).toBe(true)
  })

  it('404s for an unknown bank rather than returning an empty list', async () => {
    expect((await get('/v1/banks/bank_nosuchbank/cards')).res.status).toBe(404)
  })
})

describe('GET /v1/cards/:id', () => {
  it('returns the error envelope for an unknown id', async () => {
    const { res, body } = await get('/v1/cards/card_nosuchcard')
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('not_found')
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

describe('routing', () => {
  it('answers health', async () => {
    const { res, body } = await get('/health')
    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true })
  })

  it('uses the JSON envelope for unmatched routes', async () => {
    const { res, body } = await get('/v1/nope')
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })
})

/**
 * Networks and BINs are tracked but deliberately not published on the card, so
 * these assert against the tables rather than a response body. The one thing
 * asserted over HTTP is that the card payload still says nothing about them.
 */
describe('card networks are tracked but not published', () => {
  it('keeps networks and bins off the card payload', async () => {
    const { body } = await get('/v1/cards?limit=1')
    expect(body.data[0]).not.toHaveProperty('networks')
    expect(body.data[0]).not.toHaveProperty('bins')
    expect(JSON.stringify(body)).not.toMatch(/bin/i)
  })

  it('keeps them off a single-card read too', async () => {
    const infinia = await cardNamed('Infinia Metal')
    const { body } = await get(`/v1/cards/${infinia.id}`)
    expect(body).not.toHaveProperty('networks')
    expect(body.name).toBe('Infinia Metal')
  })

  it('gives every seeded card at least one network', async () => {
    const { results } = await env.DB.prepare(
      `SELECT c.name FROM cards c
       WHERE NOT EXISTS (SELECT 1 FROM card_networks n WHERE n.card_id = c.id)`,
    ).all()
    expect(results.map((row: any) => row.name)).toEqual([])
  })

  it('names only networks the catalog actually uses', async () => {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT nw.code AS network
       FROM card_networks cn
       JOIN networks nw ON nw.id = cn.network_id
       ORDER BY nw.code`,
    ).all()
    expect(results.map((row: any) => row.network)).toEqual([
      'amex',
      'diners',
      'mastercard',
      'rupay',
      'visa',
    ])
  })

  it('holds the real Visa Infinite prefixes for Infinia', async () => {
    const { results } = await env.DB.prepare(
      `SELECT nw.code AS network, cb.bin_prefix FROM card_bins cb
       JOIN cards c ON c.id = cb.card_id
       JOIN networks nw ON nw.id = cb.network_id
       WHERE c.name = 'Infinia Metal' ORDER BY cb.bin_prefix`,
    ).all()
    expect(results).toEqual([
      { network: 'visa', bin_prefix: '417410' },
      { network: 'visa', bin_prefix: '436152' },
      { network: 'visa', bin_prefix: '437546' },
    ])
  })

  it('records both variants of a card sold on two networks', async () => {
    const { results } = await env.DB.prepare(
      `SELECT nw.code AS network FROM card_networks cn
       JOIN cards c ON c.id = cn.card_id
       JOIN networks nw ON nw.id = cn.network_id
       WHERE c.name = 'Emeralde Private Metal' ORDER BY nw.code`,
    ).all()
    expect(results.map((row: any) => row.network)).toEqual(['mastercard', 'visa'])
  })

  it('stores no bins for a card whose tier block is too wide to mean anything', async () => {
    // Amex India is one block of 117 prefixes shared by the whole portfolio.
    const { results } = await env.DB.prepare(
      `SELECT cb.bin_prefix FROM card_bins cb
       JOIN cards c ON c.id = cb.card_id
       WHERE c.name = 'Platinum Charge Card'`,
    ).all()
    expect(results).toEqual([])
  })

  it('stores only 6- or 8-digit numeric prefixes', async () => {
    const { results } = await env.DB.prepare(
      `SELECT bin_prefix FROM card_bins
       WHERE length(bin_prefix) NOT IN (6, 8) OR bin_prefix GLOB '*[^0-9]*'`,
    ).all()
    expect(results).toEqual([])
  })

  /**
   * The reason the networks read path was removed rather than joined in: a card
   * has many networks and a network many BINs, so any join would fan one card
   * across rows and corrupt both the page size and the total. These are the
   * numbers that would move if that ever came back.
   */
  it('does not fan a card out across rows', async () => {
    const { body } = await get(`/v1/cards?limit=${SEEDED_CARDS}`)
    expect(body.data).toHaveLength(SEEDED_CARDS)
    expect(body.total).toBe(SEEDED_CARDS)
    expect(new Set(body.data.map((card: any) => card.id)).size).toBe(SEEDED_CARDS)
  })
})

describe('?network= filter', () => {
  /** Ids of the cards the tables say are on this network. */
  async function idsOnNetwork(network: string) {
    const { results } = await env.DB.prepare(
      `SELECT cn.card_id FROM card_networks cn
       JOIN networks nw ON nw.id = cn.network_id
       WHERE nw.code = ?`,
    )
      .bind(network)
      .all()
    return new Set(results.map((row: any) => row.card_id))
  }

  it('returns exactly the cards the tables put on that network', async () => {
    const { body } = await get(`/v1/cards?network=rupay&limit=${SEEDED_CARDS}`)
    const expected = await idsOnNetwork('rupay')

    expect(expected.size).toBeGreaterThan(0)
    expect(new Set(body.data.map((card: any) => card.id))).toEqual(expected)
  })

  it('agrees with its own total', async () => {
    const { body } = await get(`/v1/cards?network=visa&limit=${SEEDED_CARDS}`)
    expect(body.total).toBe(body.data.length)
  })

  it('splits the catalog across networks without losing or duplicating cards', async () => {
    const perNetwork = await Promise.all(
      ['visa', 'mastercard', 'amex', 'diners', 'rupay'].map(async (n) =>
        (await get(`/v1/cards?network=${n}&limit=${SEEDED_CARDS}`)).body.data.map(
          (card: any) => card.id,
        ),
      ),
    )
    // Cards sold on two networks appear twice across the five lists, so the
    // union -- not the sum -- is the whole catalog.
    expect(new Set(perNetwork.flat()).size).toBe(SEEDED_CARDS)
  })

  it('is case insensitive on the way in', async () => {
    const upper = await get(`/v1/cards?network=VISA&limit=${SEEDED_CARDS}`)
    const lower = await get(`/v1/cards?network=visa&limit=${SEEDED_CARDS}`)
    expect(upper.body.total).toBe(lower.body.total)
  })

  it('returns nothing for a network no card is on', async () => {
    expect((await get('/v1/cards?network=jcb')).body.total).toBe(0)
  })

  it('ignores an unknown network rather than erroring', async () => {
    const { res, body } = await get('/v1/cards?network=notanetwork')
    expect(res.status).toBe(200)
    expect(body.total).toBe(0)
  })
})

describe('query layer directly', () => {
  it('issues no query for an empty id list', async () => {
    // SQLite rejects `IN ()`; the guard must short-circuit before the SQL.
    const result = await listCards(env.DB, {
      ids: [],
      includeInactive: false,
      includeUnselectable: false,
      limit: 50,
      offset: 0,
    })
    expect(result).toEqual({ cards: [], total: 0 })
  })
})
