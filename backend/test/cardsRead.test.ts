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

async function get(path: string) {
  const res = await SELF.fetch(`${base}${path}`)
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

describe('query layer directly', () => {
  it('issues no query for an empty id list', async () => {
    // SQLite rejects `IN ()`; the guard must short-circuit before the SQL.
    const result = await listCards(env.DB, {
      ids: [],
      includeInactive: false,
      limit: 50,
      offset: 0,
    })
    expect(result).toEqual({ cards: [], total: 0 })
  })
})
