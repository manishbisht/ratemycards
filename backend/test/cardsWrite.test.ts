import { SELF, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { BANK_ID_PATTERN } from '../src/modules/banks/bankTypes'
import { CARD_ID_PATTERN, generateCardId } from '../src/modules/cards/cardTypes'

/**
 * Writes, kept in their own file: storage isolation is per test file, so these
 * rows must not leak into the counts asserted in cardsRead.test.ts.
 */

const base = 'http://api.test'
const AUTH = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }

let bankId = ''
let otherBankId = ''
let unique = 0

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

function card(overrides: Record<string, unknown> = {}) {
  unique += 1
  return { bankId, name: `Test Card ${unique}`, country: 'IN', ...overrides }
}

beforeAll(async () => {
  bankId = (await json(await send('POST', '/v1/banks', { name: 'Primary Bank' }))).id
  otherBankId = (await json(await send('POST', '/v1/banks', { name: 'Other Bank' }))).id
})

describe('POST /v1/banks', () => {
  it('mints a bank_-prefixed id', async () => {
    const res = await send('POST', '/v1/banks', { name: 'ICICI Bank' })
    expect(res.status).toBe(201)

    const body = await json(res)
    expect(body.id).toMatch(BANK_ID_PATTERN)
    expect(res.headers.get('Location')).toBe(`/v1/banks/${body.id}`)
    expect(body).toEqual({ id: body.id, name: 'ICICI Bank', isActive: true })
  })

  it('rejects a duplicate bank name with 409', async () => {
    await send('POST', '/v1/banks', { name: 'Duplicate Bank' })
    const res = await send('POST', '/v1/banks', { name: 'Duplicate Bank' })
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('conflict')
  })

  it('refuses a client-supplied id', async () => {
    const res = await send('POST', '/v1/banks', { id: 'bank_mine', name: 'Nope Bank' })
    expect(res.status).toBe(400)
  })

  it('requires auth', async () => {
    const res = await SELF.fetch(`${base}/v1/banks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Unauthorised Bank' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('POST /v1/cards', () => {
  it('mints a card_-prefixed id and embeds its bank', async () => {
    const res = await send('POST', '/v1/cards', card({ name: 'Rubyx' }))
    expect(res.status).toBe(201)

    const body = await json(res)
    expect(body.id).toMatch(CARD_ID_PATTERN)
    expect(res.headers.get('Location')).toBe(`/v1/cards/${body.id}`)
    expect(body.bank).toEqual({ id: bankId, name: 'Primary Bank' })
    expect(body.issuer).toBe('Primary Bank')
  })

  it('rejects an unknown bankId', async () => {
    const res = await send('POST', '/v1/cards', card({ bankId: generateUnknownBankId() }))
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toContain('bankId')
  })

  it('rejects a malformed bankId', async () => {
    const res = await send('POST', '/v1/cards', card({ bankId: 'not-an-id' }))
    expect(res.status).toBe(400)
  })

  it('requires a bankId', async () => {
    const res = await send('POST', '/v1/cards', { name: 'Orphan', country: 'IN' })
    expect(res.status).toBe(400)
  })

  it('rejects the same card name twice at one bank', async () => {
    const payload = card({ name: 'Repeated Card' })
    expect((await send('POST', '/v1/cards', payload)).status).toBe(201)

    const res = await send('POST', '/v1/cards', payload)
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('conflict')
  })

  it('allows the same card name at a different bank', async () => {
    await send('POST', '/v1/cards', { bankId, name: 'Shared Name', country: 'IN' })
    const res = await send('POST', '/v1/cards', {
      bankId: otherBankId,
      name: 'Shared Name',
      country: 'IN',
    })
    expect(res.status).toBe(201)
  })

  it('stores joining and annual fees independently', async () => {
    const body = await json(
      await send('POST', '/v1/cards', card({ joiningFee: 100000, annualFee: 25000 })),
    )
    expect(body.joiningFee).toBe(100000)
    expect(body.annualFee).toBe(25000)
  })

  it('defaults an omitted fee to zero', async () => {
    const body = await json(await send('POST', '/v1/cards', card()))
    expect(body.joiningFee).toBe(0)
    expect(body.annualFee).toBe(0)
  })

  it('rejects a negative or fractional fee', async () => {
    for (const fee of [-1, 12.5, '5000', null]) {
      const res = await send('POST', '/v1/cards', card({ annualFee: fee }))
      expect(res.status).toBe(400)
    }
  })

  it('normalises country case', async () => {
    const body = await json(await send('POST', '/v1/cards', card({ country: 'in' })))
    expect(body.country).toBe('IN')
  })

  it('refuses a client-supplied id', async () => {
    const res = await send('POST', '/v1/cards', card({ id: 'card_mine' }))
    expect(res.status).toBe(400)
  })

  it('reports every field problem at once', async () => {
    const res = await send('POST', '/v1/cards', { name: '', country: 'INDIA' })
    expect(res.status).toBe(400)
    expect((await json(res)).error.details).toHaveLength(3)
  })

  it('rejects malformed JSON with 400 rather than 500', async () => {
    const res = await SELF.fetch(`${base}/v1/cards`, {
      method: 'POST',
      headers: AUTH,
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

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
})

describe('the database enforces the bank link', () => {
  it('refuses a card row whose bank does not exist', async () => {
    // D1 enforces foreign keys, so this is blocked even below the API.
    await expect(
      env.DB.prepare('INSERT INTO cards (id, bank_id, name, country) VALUES (?, ?, ?, ?)')
        .bind(generateCardId(), generateUnknownBankId(), 'Orphan', 'IN')
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i)
  })

  it('refuses to hard-delete a bank that still has cards', async () => {
    await expect(
      env.DB.prepare('DELETE FROM banks WHERE id = ?').bind(bankId).run(),
    ).rejects.toThrow(/FOREIGN KEY/i)
  })
})

describe('PATCH /v1/cards/:id', () => {
  it('can move a card to another bank', async () => {
    const created = await json(await send('POST', '/v1/cards', card()))

    const body = await json(await send('PATCH', `/v1/cards/${created.id}`, { bankId: otherBankId }))
    expect(body.bank).toEqual({ id: otherBankId, name: 'Other Bank' })
    expect(body.issuer).toBe('Other Bank')
    expect(body.name).toBe(created.name)
  })

  it('rejects a move to an unknown bank', async () => {
    const created = await json(await send('POST', '/v1/cards', card()))
    const res = await send('PATCH', `/v1/cards/${created.id}`, {
      bankId: generateUnknownBankId(),
    })
    expect(res.status).toBe(400)
  })

  it('updates a fee without touching the rest of the card', async () => {
    const created = await json(await send('POST', '/v1/cards', card({ annualFee: 5000 })))

    const body = await json(await send('PATCH', `/v1/cards/${created.id}`, { annualFee: 0 }))
    expect(body.annualFee).toBe(0)
    expect(body.joiningFee).toBe(created.joiningFee)
    expect(body.name).toBe(created.name)
  })

  it('404s on an unknown card', async () => {
    expect((await send('PATCH', '/v1/cards/card_nope', { name: 'x' })).status).toBe(404)
  })

  it('rejects an empty patch', async () => {
    const created = await json(await send('POST', '/v1/cards', card()))
    expect((await send('PATCH', `/v1/cards/${created.id}`, {})).status).toBe(400)
  })
})

/**
 * The write path still owns card_networks, but the card it returns says nothing
 * about them -- so these read the table back rather than the response body.
 */
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

  it('lets the database reject a BIN whose digits are not numeric', async () => {
    const created = await json(
      await send('POST', '/v1/cards', card({ networks: [{ code: 'visa', bins: [] }] })),
    )
    await expect(
      env.DB.prepare(
        `INSERT INTO card_bins (card_id, network_id, bin_prefix)
         SELECT ?, id, ? FROM networks WHERE code = ?`,
      )
        .bind(created.id, '51234x', 'visa')
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  /**
   * What the planned GET /v1/cards/:id/bins has to answer: every prefix for a
   * card, flattened across all of its networks. Written through the API now
   * rather than raw SQL, since one call can carry the whole set.
   */
  it('can flatten every prefix across a card\'s networks', async () => {
    const created = await json(
      await send('POST', '/v1/cards', card({
        networks: [
          { code: 'visa', bins: ['412345', '498765'] },
          { code: 'mastercard', bins: ['521234'] },
          { code: 'rupay', bins: ['652345'] },
        ],
      })),
    )

    const { results } = await env.DB.prepare(
      'SELECT bin_prefix FROM card_bins WHERE card_id = ? ORDER BY bin_prefix',
    )
      .bind(created.id)
      .all()

    expect(results.map((row: any) => row.bin_prefix)).toEqual([
      '412345',
      '498765',
      '521234',
      '652345',
    ])
  })
})

describe('PATCH /v1/banks/:id', () => {
  it('renames a bank, and its cards report the new name', async () => {
    const renameBankId = (await json(await send('POST', '/v1/banks', { name: 'Before Rename' }))).id
    const created = await json(
      await send('POST', '/v1/cards', { bankId: renameBankId, name: 'Linked', country: 'IN' }),
    )

    await send('PATCH', `/v1/banks/${renameBankId}`, { name: 'After Rename' })

    const card = await json(await SELF.fetch(`${base}/v1/cards/${created.id}`))
    expect(card.bank.name).toBe('After Rename')
    expect(card.issuer).toBe('After Rename')
  })

  it('404s on an unknown bank', async () => {
    expect((await send('PATCH', '/v1/banks/bank_nope', { name: 'x' })).status).toBe(404)
  })
})

describe('DELETE', () => {
  it('soft deletes a card: hidden by default, visible with includeInactive', async () => {
    const created = await json(await send('POST', '/v1/cards', card()))

    expect((await send('DELETE', `/v1/cards/${created.id}`)).status).toBe(204)

    const hidden = await json(await SELF.fetch(`${base}/v1/cards?ids=${created.id}`))
    expect(hidden.total).toBe(0)

    const shown = await json(
      await SELF.fetch(`${base}/v1/cards?ids=${created.id}&includeInactive=true`),
    )
    expect(shown.total).toBe(1)
    expect(shown.data[0].isActive).toBe(false)

    // Still resolvable by id, so a wallet holding it can render its name.
    expect((await SELF.fetch(`${base}/v1/cards/${created.id}`)).status).toBe(200)
  })

  it('soft deletes a bank without touching its cards', async () => {
    const doomedBankId = (await json(await send('POST', '/v1/banks', { name: 'Doomed Bank' }))).id
    const created = await json(
      await send('POST', '/v1/cards', { bankId: doomedBankId, name: 'Survivor', country: 'IN' }),
    )

    expect((await send('DELETE', `/v1/banks/${doomedBankId}`)).status).toBe(204)

    // The bank drops out of the default listing...
    const banks = await json(await SELF.fetch(`${base}/v1/banks?q=Doomed`))
    expect(banks.total).toBe(0)

    // ...but its card survives and still resolves its issuer.
    const card = await json(await SELF.fetch(`${base}/v1/cards/${created.id}`))
    expect(card.bank.name).toBe('Doomed Bank')
  })

  it('404s on an unknown card or bank', async () => {
    expect((await send('DELETE', '/v1/cards/card_nope')).status).toBe(404)
    expect((await send('DELETE', '/v1/banks/bank_nope')).status).toBe(404)
  })
})

/** A syntactically valid bank id that was never inserted. */
function generateUnknownBankId(): string {
  return `bank_${'0'.repeat(31)}1`
}
