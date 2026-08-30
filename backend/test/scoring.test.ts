import { SELF, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { CRITERION_ID_PATTERN, generateCriterionId } from '../src/modules/scoring/scoringTypes'

/**
 * The rubric and the derived rating. Writes, so this file is isolated from the
 * read-path counts in cardsRead.test.ts.
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

let bankId = ''
let lounge = ''
let fees = ''

async function newCard(name: string): Promise<string> {
  const res = await send('POST', '/v1/cards', { bankId, name, country: 'IN' })
  return (await json(res)).id
}

beforeAll(async () => {
  bankId = (await json(await send('POST', '/v1/banks', { name: 'Scoring Bank' }))).id
  lounge = (await json(await send('POST', '/v1/criteria', { name: 'Lounge access', weight: 3 }))).id
  fees = (await json(await send('POST', '/v1/criteria', { name: 'Annual fee value', weight: 1 }))).id
})

describe('POST /v1/criteria', () => {
  it('mints a crit_-prefixed id', async () => {
    const res = await send('POST', '/v1/criteria', { name: 'Reward rate', weight: 5 })
    expect(res.status).toBe(201)

    const body = await json(res)
    expect(body.id).toMatch(CRITERION_ID_PATTERN)
    expect(res.headers.get('Location')).toBe(`/v1/criteria/${body.id}`)
    expect(body).toEqual({
      id: body.id,
      name: 'Reward rate',
      description: null,
      weight: 5,
      isActive: true,
    })
  })

  it('stores a description of what the criterion measures', async () => {
    const body = await json(
      await send('POST', '/v1/criteria', {
        name: 'Described criterion',
        description: 'Effective reward rate and redemption value',
        weight: 4,
      }),
    )
    expect(body.description).toBe('Effective reward rate and redemption value')

    const cleared = await json(await send('PATCH', `/v1/criteria/${body.id}`, { description: null }))
    expect(cleared.description).toBeNull()
  })

  it('defaults weight to 1', async () => {
    const body = await json(await send('POST', '/v1/criteria', { name: 'Unweighted criterion' }))
    expect(body.weight).toBe(1)
  })

  it('rejects a duplicate name with 409', async () => {
    await send('POST', '/v1/criteria', { name: 'Repeated criterion' })
    expect((await send('POST', '/v1/criteria', { name: 'Repeated criterion' })).status).toBe(409)
  })

  it('rejects an out-of-range or fractional weight', async () => {
    expect((await send('POST', '/v1/criteria', { name: 'W1', weight: 101 })).status).toBe(400)
    expect((await send('POST', '/v1/criteria', { name: 'W2', weight: 1.5 })).status).toBe(400)
    expect((await send('POST', '/v1/criteria', { name: 'W3', weight: -1 })).status).toBe(400)
  })

  it('requires auth', async () => {
    const res = await SELF.fetch(`${base}/v1/criteria`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Unauthorised' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('PUT /v1/cards/:id/scores', () => {
  it('stores the set and derives a weighted rating', async () => {
    const cardId = await newCard('Weighted Card')

    const res = await send('PUT', `/v1/cards/${cardId}/scores`, {
      scores: [
        { criterionId: lounge, score: 9 },
        { criterionId: fees, score: 4 },
      ],
    })
    expect(res.status).toBe(200)

    // (9*3 + 4*1) / (3+1) = 7.75 -- not the plain mean of 6.5.
    const body = await json(res)
    expect(body.rating.score).toBe(7.75)
    expect(body.rating.max).toBe(10)
    expect(body.rating.scoredCriteria).toBe(2)
    expect(body.total).toBe(2)
  })

  it('puts the rating on the card itself', async () => {
    const cardId = await newCard('Rated Card')
    await send('PUT', `/v1/cards/${cardId}/scores`, {
      scores: [{ criterionId: lounge, score: 10 }],
    })

    const breakdown = await json(await send('GET', `/v1/cards/${cardId}/scores`))
    expect(breakdown.rating.score).toBe(10)
    expect(breakdown.rating.scoredCriteria).toBe(1)
    expect(breakdown.rating.totalCriteria).toBeGreaterThan(1)

    // ...and stays off the public card.
    const card = await json(await SELF.fetch(`${base}/v1/cards/${cardId}`))
    expect('rating' in card).toBe(false)
  })

  it('replaces rather than accumulating', async () => {
    const cardId = await newCard('Replaced Card')
    const payload = { scores: [{ criterionId: lounge, score: 5 }] }

    await send('PUT', `/v1/cards/${cardId}/scores`, payload)
    const second = await json(await send('PUT', `/v1/cards/${cardId}/scores`, payload))
    expect(second.total).toBe(1)
  })

  it('clears the set when given an empty array', async () => {
    const cardId = await newCard('Cleared Card')
    await send('PUT', `/v1/cards/${cardId}/scores`, {
      scores: [{ criterionId: lounge, score: 8 }],
    })

    const body = await json(await send('PUT', `/v1/cards/${cardId}/scores`, { scores: [] }))
    expect(body.data).toEqual([])
    expect(body.rating.score).toBeNull()
    expect(body.rating.scoredCriteria).toBe(0)
  })

  it('rejects a score outside 0-10', async () => {
    const cardId = await newCard('Out Of Range Card')
    for (const score of [11, -1, 7.5, '9']) {
      const res = await send('PUT', `/v1/cards/${cardId}/scores`, {
        scores: [{ criterionId: lounge, score }],
      })
      expect(res.status).toBe(400)
    }
  })

  it('rejects the same criterion scored twice', async () => {
    const cardId = await newCard('Duplicate Score Card')
    const res = await send('PUT', `/v1/cards/${cardId}/scores`, {
      scores: [
        { criterionId: lounge, score: 3 },
        { criterionId: lounge, score: 8 },
      ],
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toContain('same criterion twice')
  })

  it('rejects an unknown criterion', async () => {
    const cardId = await newCard('Unknown Criterion Card')
    const res = await send('PUT', `/v1/cards/${cardId}/scores`, {
      scores: [{ criterionId: generateCriterionId(), score: 5 }],
    })
    expect(res.status).toBe(400)
  })

  it('404s on an unknown card', async () => {
    const res = await send('PUT', '/v1/cards/card_nope/scores', { scores: [] })
    expect(res.status).toBe(404)
  })

  it('requires auth to write but not to read', async () => {
    const cardId = await newCard('Auth Score Card')
    const unauthorised = await SELF.fetch(`${base}/v1/cards/${cardId}/scores`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scores: [] }),
    })
    expect(unauthorised.status).toBe(401)
    // The breakdown is admin-only too: it is the raw judgement behind a card.
    expect((await SELF.fetch(`${base}/v1/cards/${cardId}/scores`)).status).toBe(401)
    expect((await send('GET', `/v1/cards/${cardId}/scores`)).status).toBe(200)
  })
})

describe('GET /v1/cards/:id/scores', () => {
  it('returns the breakdown with each criterion inlined, heaviest first', async () => {
    const cardId = await newCard('Breakdown Card')
    await send('PUT', `/v1/cards/${cardId}/scores`, {
      scores: [
        { criterionId: fees, score: 4 },
        { criterionId: lounge, score: 9 },
      ],
    })

    const body = await json(await send('GET', `/v1/cards/${cardId}/scores`))
    expect(body.data.map((entry: any) => entry.criterion.name)).toEqual([
      'Lounge access',
      'Annual fee value',
    ])
    expect(body.data[0].score).toBe(9)
    expect(body.data[0].criterion.weight).toBe(3)
  })

  it('is empty for an unscored card', async () => {
    const cardId = await newCard('Unscored Card')
    const body = await json(await send('GET', `/v1/cards/${cardId}/scores`))
    expect(body.data).toEqual([])
    expect(body.rating.score).toBeNull()
  })
})

describe('re-weighting re-rates without a backfill', () => {
  it('changes the rating when a criterion weight changes', async () => {
    const cardId = await newCard('Reweighted Card')
    const heavy = (await json(await send('POST', '/v1/criteria', { name: 'Heavy', weight: 1 }))).id
    const light = (await json(await send('POST', '/v1/criteria', { name: 'Light', weight: 1 }))).id

    await send('PUT', `/v1/cards/${cardId}/scores`, {
      scores: [
        { criterionId: heavy, score: 10 },
        { criterionId: light, score: 0 },
      ],
    })
    const rating = async () =>
      (await json(await send('GET', `/v1/cards/${cardId}/scores`))).rating.score

    expect(await rating()).toBe(5)

    await send('PATCH', `/v1/criteria/${heavy}`, { weight: 9 })

    // (10*9 + 0*1) / 10 = 9 -- no score row was touched.
    expect(await rating()).toBe(9)
  })

  it('drops a deactivated criterion out of the rating', async () => {
    const cardId = await newCard('Deactivation Card')
    const kept = (await json(await send('POST', '/v1/criteria', { name: 'Kept', weight: 1 }))).id
    const dropped = (await json(await send('POST', '/v1/criteria', { name: 'Dropped', weight: 1 })))
      .id

    await send('PUT', `/v1/cards/${cardId}/scores`, {
      scores: [
        { criterionId: kept, score: 10 },
        { criterionId: dropped, score: 0 },
      ],
    })
    const read = async () => (await json(await send('GET', `/v1/cards/${cardId}/scores`))).rating
    expect((await read()).score).toBe(5)

    await send('DELETE', `/v1/criteria/${dropped}`)

    const rating = await read()
    expect(rating.score).toBe(10)
    expect(rating.scoredCriteria).toBe(1)
  })

  it('reports a null rating when every scored criterion weighs zero', async () => {
    const cardId = await newCard('Zero Weight Card')
    const zero = (await json(await send('POST', '/v1/criteria', { name: 'Zero', weight: 0 }))).id

    await send('PUT', `/v1/cards/${cardId}/scores`, {
      scores: [{ criterionId: zero, score: 7 }],
    })

    // Must not divide by zero.
    const rating = (await json(await send('GET', `/v1/cards/${cardId}/scores`))).rating
    expect(rating.score).toBeNull()
    expect(rating.scoredCriteria).toBe(1)
  })
})

describe('the database enforces the scoring links', () => {
  it('refuses a score row for an unknown criterion', async () => {
    const cardId = await newCard('FK Score Card')
    await expect(
      env.DB.prepare('INSERT INTO card_scores (card_id, criterion_id, score) VALUES (?, ?, ?)')
        .bind(cardId, generateCriterionId(), 5)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i)
  })

  it('refuses a score outside the 0-10 scale', async () => {
    const cardId = await newCard('CHECK Score Card')
    await expect(
      env.DB.prepare('INSERT INTO card_scores (card_id, criterion_id, score) VALUES (?, ?, ?)')
        .bind(cardId, lounge, 42)
        .run(),
    ).rejects.toThrow(/CHECK/i)
  })

  it('refuses the same criterion twice for one card', async () => {
    const cardId = await newCard('PK Score Card')
    const insert = () =>
      env.DB.prepare('INSERT INTO card_scores (card_id, criterion_id, score) VALUES (?, ?, ?)')
        .bind(cardId, lounge, 5)
        .run()

    await insert()
    await expect(insert()).rejects.toThrow(/UNIQUE|PRIMARY KEY/i)
  })
})

describe('criteria listing', () => {
  it('orders by weight, heaviest first', async () => {
    const body = await json(await SELF.fetch(`${base}/v1/criteria?limit=100`))
    const weights = body.data.map((criterion: any) => criterion.weight)
    expect([...weights]).toEqual([...weights].sort((a: number, b: number) => b - a))
  })

  it('hides deactivated criteria unless asked', async () => {
    const id = (await json(await send('POST', '/v1/criteria', { name: 'Hidden criterion' }))).id
    await send('DELETE', `/v1/criteria/${id}`)

    expect((await json(await SELF.fetch(`${base}/v1/criteria?q=Hidden`))).total).toBe(0)
    expect(
      (await json(await SELF.fetch(`${base}/v1/criteria?q=Hidden&includeInactive=true`))).total,
    ).toBe(1)
  })

  it('404s on an unknown criterion', async () => {
    expect((await SELF.fetch(`${base}/v1/criteria/crit_nope`)).status).toBe(404)
  })
})
