import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The BIN visibility gate and the bank-active gate. Its own file because these
 * tests write, and cardsRead.test.ts asserts exact seeded counts.
 */

const base = 'http://api.test'
const AUTH = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }

/**
 * GET requests skip the admin token deliberately. `/v1/cards` and
 * `/v1/cards/:id` go through `optionalUser`, which verifies any bearer token
 * present as a Clerk session token -- unlike `adminAuth`, which checks a
 * static secret. The admin token is neither, so sending it on a read 401s the
 * request instead of leaving the caller anonymous.
 */
function send(method: string, path: string, body?: unknown) {
  return SELF.fetch(`${base}${path}`, {
    method,
    headers: method === 'GET' ? { 'Content-Type': 'application/json' } : AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function json(res: Response) {
  return (await res.json()) as any
}

/**
 * A card with no BIN prefixes cannot be verified, so it is not offered. The
 * rule is discovery-scoped, NOT resolution-scoped: three call sites resolve
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

  it('reports selectable on the card so a client can filter without guessing', async () => {
    const gated = await json(await send('GET', `/v1/cards?ids=${gatedId}`))
    expect(gated.data[0].selectable).toBe(false)

    const withBins = await json(await send('GET', '/v1/cards?limit=1'))
    expect(withBins.data[0].selectable).toBe(true)
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
    // Matches how the real resolution call sites do it (getWallet, /wallet/preview,
    // knownCardIds): they hardcode includeInactive: true rather than relying on
    // ids= alone, and cardsWrite.test.ts's own soft-delete test establishes the
    // same convention for a deactivated card. ids= does not bypass this gate by
    // itself -- only the BIN gate has that carve-out.
    expect(
      (
        await json(
          await send('GET', `/v1/cards?ids=${card.id}&includeInactive=true`),
        )
      ).data.map((c: any) => c.id),
    ).toEqual([card.id])
  })
})
