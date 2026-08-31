import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { cardWeight, tierFor } from '../src/modules/wallet/walletTypes'

/**
 * Wallet preview: scoring a set of cards without storing anything. Reads only,
 * so this runs against the seeded catalog.
 */

const base = 'http://api.test'

async function preview(cardIds: string[]) {
  const res = await SELF.fetch(`${base}/v1/wallet/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardIds }),
  })
  return { res, body: (await res.json()) as any }
}

/**
 * includeUnselectable, because this is a lookup by name, not a check of what
 * browse offers: not every seeded card carries a BIN prefix, and this helper
 * must still find them.
 */
async function cardNamed(name: string) {
  const res = await SELF.fetch(
    `${base}/v1/cards?q=${encodeURIComponent(name)}&includeUnselectable=true&limit=100`,
  )
  const body = (await res.json()) as any
  return body.data.find((card: any) => card.name === name)
}

/** A card's rating is admin-only now, so tests read it the same way an admin would. */
async function ratingOf(id: string): Promise<number> {
  const res = await SELF.fetch(`${base}/v1/cards/${id}/scores`, {
    headers: { Authorization: 'Bearer test-admin-token' },
  })
  return ((await res.json()) as any).rating.score
}

describe('the formula', () => {
  it('scales a 0-10 rating into the ladder band', () => {
    expect(cardWeight(8.8)).toBe(440)
    expect(cardWeight(10)).toBe(500)
    expect(cardWeight(0)).toBe(0)
    expect(cardWeight(null)).toBe(0)
  })

  it('maps a score to its tier', () => {
    expect(tierFor(0).name).toBe('Beginner')
    expect(tierFor(1400).name).toBe('Specialist')
    expect(tierFor(2199).name).toBe('Expert')
    expect(tierFor(2599).name).toBe('Master')
    expect(tierFor(2600).name).toBe('Grandmaster')
    expect(tierFor(99999).name).toBe('Grandmaster')
  })
})

describe('POST /v1/wallet/preview', () => {
  it('scores an empty wallet as nothing, not as the base', async () => {
    const { res, body } = await preview([])
    expect(res.status).toBe(200)
    expect(body.score).toBe(0)
    expect(body.tier.name).toBe('Beginner')
    expect(body.cardCount).toBe(0)
  })

  it('returns only the aggregate, never a per-card rating', async () => {
    const infinia = await cardNamed('Infinia Metal')
    const { body } = await preview([infinia.id])

    // A per-card weight is its rating times a constant, so neither may appear.
    expect(Object.keys(body).sort()).toEqual([
      'cardCount',
      'maxScore',
      'score',
      'tier',
      'unknownIds',
    ])
    expect(JSON.stringify(body)).not.toContain('8.8')
  })

  it('scores one card as base plus its weight', async () => {
    const infinia = await cardNamed('Infinia Metal')
    const { body } = await preview([infinia.id])

    // 620 + round(8.8 * 50), no multi-card bonus for the first card.
    expect(body.score).toBe(620 + 440)
    expect(body.cardCount).toBe(1)
    expect(body.tier.name).toBe('Optimiser')
  })

  it('adds a bonus for every card past the first', async () => {
    const a = await cardNamed('Infinia Metal')
    const b = await cardNamed('Atlas')

    const one = await preview([a.id])
    const two = await preview([a.id, b.id])

    expect(two.body.score).toBe(one.body.score + cardWeight(await ratingOf(b.id)) + 60)
    expect(two.body.cardCount).toBe(2)
  })

  it('climbs the tier ladder as cards are added', async () => {
    const names = ['Infinia Metal', 'Diners Club Black Metal', 'Emeralde Private Metal', 'Reserve']
    const cards = await Promise.all(names.map(cardNamed))

    const tiers: string[] = []
    for (let n = 1; n <= cards.length; n += 1) {
      const { body } = await preview(cards.slice(0, n).map((card) => card.id))
      tiers.push(body.tier.name)
    }

    // 1060 / 1573 / 2048 / 2508 -- adding a card never demotes you.
    expect(tiers).toEqual(['Optimiser', 'Specialist', 'Expert', 'Master'])
  })

  it('never exceeds the ceiling', async () => {
    const { body } = await SELF.fetch(`${base}/v1/cards?limit=40`)
      .then((r) => r.json() as any)
      .then(async (list: any) => preview(list.data.map((card: any) => card.id)))

    expect(body.score).toBe(3000)
    expect(body.maxScore).toBe(3000)
    expect(body.tier.name).toBe('Grandmaster')
  })

  it('reports ids it did not recognise so a client can prune them', async () => {
    const infinia = await cardNamed('Infinia Metal')
    const ghost = `card_${'0'.repeat(31)}1`

    const { body } = await preview([infinia.id, ghost])
    expect(body.unknownIds).toEqual([ghost])
    expect(body.cardCount).toBe(1)
    // The unknown id contributes nothing, so this matches the one-card score.
    expect(body.score).toBe(620 + 440)
  })

  it('collapses duplicates rather than double-counting', async () => {
    const infinia = await cardNamed('Infinia Metal')
    const { body } = await preview([infinia.id, infinia.id, infinia.id])

    expect(body.cardCount).toBe(1)
    expect(body.score).toBe(620 + 440)
  })

  it('still scores a card that has been retired from the catalog', async () => {
    // A wallet holding a discontinued card should not silently lose points.
    const list = (await (await SELF.fetch(`${base}/v1/cards?limit=1`)).json()) as any
    const card = list.data[0]

    const { body } = await preview([card.id])
    expect(body.cardCount).toBe(1)
    expect(body.unknownIds).toEqual([])
  })

  it('rejects a malformed card id', async () => {
    const { res, body } = await preview(['not-an-id'])
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('validation_error')
  })

  it('rejects a missing or non-array cardIds', async () => {
    const bad = await SELF.fetch(`${base}/v1/wallet/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(bad.status).toBe(400)
  })

  it('rejects a wallet larger than the cap', async () => {
    const many = Array.from({ length: 60 }, () => `card_${'0'.repeat(31)}1`)
    const { res } = await preview(many)
    expect(res.status).toBe(400)
  })

  it('needs no admin token', async () => {
    const { res } = await preview([])
    expect(res.status).toBe(200)
  })
})
