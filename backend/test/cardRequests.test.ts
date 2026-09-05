import { SELF, env } from 'cloudflare:test'
import { signJwt } from '@clerk/backend/jwt'
import { beforeAll, describe, expect, it } from 'vitest'
import { MAX_OPEN_REQUESTS } from '../src/modules/cardRequests/cardRequestTypes'
import { MAX_REQUEST_BINS } from '../src/modules/cardRequests/validate'

/**
 * Card and BIN requests, and the review queue behind them.
 *
 * A *write* file -- it mints its own bank, cards and users, so nothing here
 * disturbs the seed counts asserted in cardsRead.test.ts.
 *
 * The tests that carry the design are the approval ones. Two of them pin
 * decisions that an earlier draft of this feature got wrong, and both would
 * pass just as happily against the wrong behaviour if they were softened:
 * approving a card with no BIN prefixes must SUCCEED, and approving a BIN
 * request must succeed even when the admin recorded a different prefix from the
 * one that was asked for. See migration 0016.
 */

const base = 'http://api.test'
const ADMIN = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' }
const AZP = 'http://localhost:5173'

async function mintToken(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    { iss: 'https://clerk.test.example', azp: AZP, iat: now - 5, nbf: now - 5, exp: now + 600, ...claims },
    JSON.parse(env.TEST_JWT_PRIVATE_KEY) as JsonWebKey,
    { algorithm: 'RS256', header: { kid: env.TEST_JWT_KID } },
  )
}

function as(token: string, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  }
}

async function json(res: Response) {
  return (await res.json()) as any
}

let token = ''
let otherToken = ''
let adminToken = ''
let plainToken = ''
let floodToken = ''
let bankId = ''
let binCard = ''
let binlessCard = ''
let dualCard = ''
let retiredCard = ''

/** POST /v1/cards as an admin, returning the new id. */
async function makeCard(
  name: string,
  networks: { code: string; bins: string[] }[] = [],
): Promise<string> {
  const res = await SELF.fetch(`${base}/v1/cards`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify({ bankId, name, country: 'IN', networks }),
  })
  expect(res.status, `create ${name} -> ${await res.clone().text()}`).toBe(201)
  return (await json(res)).id
}

/** POST a request as `sessionToken`, returning the response and its body. */
async function submit(body: unknown, sessionToken = token) {
  const res = await SELF.fetch(
    `${base}/v1/card-requests`,
    as(sessionToken, { method: 'POST', body: JSON.stringify(body) }),
  )
  return { res, body: await json(res) }
}

/** A 'card' request that will pass validation, with a unique product name. */
function cardBody(name: string, extra: Record<string, unknown> = {}) {
  return { kind: 'card', issuer: 'A Bank We Do Not Carry', cardName: name, network: 'visa', ...extra }
}

/**
 * A requester nobody else has used.
 *
 * The cap on open requests is real, and a shared user walks into it partway
 * through the file. Tests that only need *somebody* to have asked mint their
 * own, for the same reason freshCard exists in verification.test.ts: a test
 * that depends on how much the tests above left pending is a test that breaks
 * when one of them is reordered.
 */
let userSeq = 0
async function freshUser(): Promise<string> {
  userSeq += 1
  return mintToken({ sub: `clerk_req_gen_${userSeq}` })
}

async function approve(id: string, body: unknown = {}, headers = ADMIN) {
  const res = await SELF.fetch(`${base}/v1/card-requests/${id}/approve`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { res, body: await json(res) }
}

beforeAll(async () => {
  token = await mintToken({ sub: 'clerk_req_main' })
  otherToken = await mintToken({ sub: 'clerk_req_other' })
  plainToken = await mintToken({ sub: 'clerk_req_plain' })
  floodToken = await mintToken({ sub: 'clerk_req_flood' })
  // The ADMIN_EMAILS binding in vitest.config.ts grants this address is_admin
  // on first sign-in, which is what gives us a Clerk-session admin to tell
  // apart from the shared ADMIN_TOKEN.
  adminToken = await mintToken({ sub: 'clerk_req_admin', email: 'admin@test.example' })

  bankId = (
    await json(
      await SELF.fetch(`${base}/v1/banks`, {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify({ name: 'Card Request Test Bank' }),
      }),
    )
  ).id

  binCard = await makeCard('Request Target With Bins', [{ code: 'visa', bins: ['411111'] }])
  binlessCard = await makeCard('Request Target Without Bins')
  dualCard = await makeCard('Request Target Dual Network', [
    { code: 'visa', bins: ['412345', '414141'] },
    { code: 'rupay', bins: ['650001'] },
  ])
  retiredCard = await makeCard('Request Target Retired', [{ code: 'visa', bins: ['413131'] }])
  await SELF.fetch(`${base}/v1/cards/${retiredCard}`, { method: 'DELETE', headers: ADMIN })
})

describe('submitting a request', () => {
  it('turns an anonymous submission away', async () => {
    const res = await SELF.fetch(`${base}/v1/card-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cardBody('Anonymous Ask')),
    })
    expect(res.status).toBe(401)
  })

  it('records a card nobody carries, with the prefixes proposed for it', async () => {
    const { res, body } = await submit(
      cardBody('Brand New Product', { bins: ['411000', '41100011'], note: 'Launched last month.' }),
    )

    expect(res.status, JSON.stringify(body)).toBe(201)
    expect(res.headers.get('Location')).toBe(`/v1/card-requests/${body.id}`)
    expect(body.id).toMatch(/^creq_[0-9a-f]{32}$/)
    expect(body.status).toBe('pending')
    expect(body.kind).toBe('card')
    expect(body.proposal).toMatchObject({ issuer: 'A Bank We Do Not Carry', name: 'Brand New Product' })
    // No such issuer, so nothing to adopt.
    expect(body.proposal.bankId).toBeNull()
    expect(body.bins).toEqual(['411000', '41100011'])
    expect(body.card).toBeNull()
  })

  it('takes the bank by id, with no issuer name to go wrong', async () => {
    // What the form sends: the picker offers the banks we carry, so the request
    // names one by id and the display name is read from the row.
    const { res, body } = await submit({
      kind: 'card',
      bankId,
      cardName: 'Picked By Id Product',
      network: 'visa',
    })

    expect(res.status, JSON.stringify(body)).toBe(201)
    expect(body.proposal.bankId).toBe(bankId)
    expect(body.proposal.issuer).toBe('Card Request Test Bank')
  })

  it('lets the id win when a name comes along with it', async () => {
    const { res, body } = await submit({
      kind: 'card',
      bankId,
      issuer: 'Something Else Entirely',
      cardName: 'Id Beats Name Product',
      network: 'visa',
    })

    expect(res.status, JSON.stringify(body)).toBe(201)
    expect(body.proposal.issuer).toBe('Card Request Test Bank')
  })

  it('adopts an issuer we already carry however it was typed', async () => {
    const { res, body } = await submit({
      kind: 'card',
      issuer: 'card request test bank',
      cardName: 'Adopted Issuer Product',
      network: 'visa',
    })

    expect(res.status, JSON.stringify(body)).toBe(201)
    expect(body.proposal.bankId).toBe(bankId)
    // Recorded under the catalog's spelling, not the requester's.
    expect(body.proposal.issuer).toBe('Card Request Test Bank')
  })

  it('answers now the conflict the admin would hit later', async () => {
    const { res, body } = await submit({
      kind: 'card',
      issuer: 'Card Request Test Bank',
      cardName: 'request target with bins',
      network: 'visa',
    })

    expect(res.status).toBe(409)
    expect(body.error.message).toMatch(/already in the catalog/i)
  })

  it('turns down a bogus bankId rather than failing on the constraint', async () => {
    const { res, body } = await submit(
      cardBody('Bad Bank Product', { bankId: 'bank_' + '0'.repeat(32) }),
    )
    expect(res.status, JSON.stringify(body)).toBe(404)
  })

  it('records a BIN request against a card we do carry', async () => {
    const { res, body } = await submit({ kind: 'bin', cardId: binCard, network: 'visa', bins: ['411112'] })

    expect(res.status, JSON.stringify(body)).toBe(201)
    expect(body.kind).toBe('bin')
    expect(body.card).toMatchObject({ id: binCard, selectable: true })
    expect(body.proposal).toBeNull()
  })

  it('has nothing to offer for a card that is not there', async () => {
    const { res } = await submit({ kind: 'bin', cardId: 'card_' + '0'.repeat(32), network: 'visa' })
    expect(res.status).toBe(404)
  })

  it('has nothing to offer for a card we retired', async () => {
    const { res } = await submit({ kind: 'bin', cardId: retiredCard, network: 'visa' })
    expect(res.status).toBe(404)
  })

  it('rejects a prefix that cannot belong to the network it was filed under', async () => {
    // Visa's seeded rule is `4*`; this is a Mastercard prefix.
    const { res, body } = await submit(cardBody('Wrong Network Product', { bins: ['511111'] }))

    expect(res.status).toBe(400)
    expect(body.error.details).toContainEqual(expect.stringContaining("'511111' is not valid"))
  })

  it('rejects a prefix of the wrong length', async () => {
    const { res, body } = await submit(cardBody('Short Prefix Product', { bins: ['4111111'] }))

    expect(res.status).toBe(400)
    expect(body.error.details).toContainEqual(expect.stringContaining('must be 6 or 8 digits'))
  })

  it('tells somebody pasting a card number exactly what went wrong, without echoing it', async () => {
    const pan = '4111111111111111'
    const { res, body } = await submit(cardBody('Pasted PAN Product', { bins: [pan] }))

    expect(res.status).toBe(400)
    const details = body.error.details.join(' ')
    expect(details).toMatch(/never enter your full card number/i)
    expect(details).not.toContain(pan)
  })

  it('caps how many prefixes one request may carry', async () => {
    const bins = Array.from({ length: MAX_REQUEST_BINS + 1 }, (_, i) =>
      String(411000 + i).padStart(6, '0'),
    )
    const { res, body } = await submit(cardBody('Too Many Prefixes Product', { bins }))

    expect(res.status).toBe(400)
    expect(body.error.details.join(' ')).toMatch(/at most/i)
  })

  it('stores a prefix listed twice once', async () => {
    const { res, body } = await submit(
      cardBody('Repeated Prefix Product', { bins: ['411222', '411222'] }),
    )
    expect(res.status, JSON.stringify(body)).toBe(201)
    expect(body.bins).toEqual(['411222'])
  })

  it("refuses a 'bin' body that also describes a new card", async () => {
    const { res, body } = await submit({
      kind: 'bin',
      cardId: binCard,
      cardName: 'Smuggled In',
      network: 'visa',
    })

    expect(res.status).toBe(400)
    expect(body.error.details.join(' ')).toMatch(/does not belong/i)
  })

  it('reports every fault at once rather than one per round trip', async () => {
    const { res, body } = await submit({ kind: 'card', network: 'nope', bins: ['zz'] })

    expect(res.status).toBe(400)
    expect(body.error.details.length).toBeGreaterThanOrEqual(3)
  })
})

describe('keeping the queue from filling up with the same ask', () => {
  it('lets one person open only one request per card', async () => {
    const first = await submit({ kind: 'bin', cardId: dualCard, network: 'visa', bins: ['412121'] })
    expect(first.res.status, JSON.stringify(first.body)).toBe(201)

    const second = await submit({ kind: 'bin', cardId: dualCard, network: 'visa' })
    expect(second.res.status).toBe(409)

    // The loser must not have taken the winner's prefixes with it.
    const kept = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM card_request_bins WHERE request_id = ?',
    )
      .bind(first.body.id)
      .first<{ n: number }>()
    expect(kept?.n).toBe(1)
  })

  it('lets two different people ask for the same card', async () => {
    const mine = await submit(cardBody('Popular Product'))
    const theirs = await submit(cardBody('Popular Product'), otherToken)

    expect(mine.res.status).toBe(201)
    expect(theirs.res.status, JSON.stringify(theirs.body)).toBe(201)
  })

  it('stops one person holding more than the cap open at once', async () => {
    for (let i = 0; i < MAX_OPEN_REQUESTS; i += 1) {
      const { res } = await submit(cardBody(`Flood Product ${i}`), floodToken)
      expect(res.status).toBe(201)
    }

    const { res, body } = await submit(cardBody('Flood Product Overflow'), floodToken)
    expect(res.status).toBe(409)
    expect(body.error.message).toMatch(/withdraw one/i)
  })
})

describe('reading requests back', () => {
  it('shows a person their own and nobody else’s', async () => {
    const mine = await json(await SELF.fetch(`${base}/v1/card-requests`, as(token)))
    const theirs = await json(await SELF.fetch(`${base}/v1/card-requests`, as(otherToken)))

    const myIds = new Set(mine.data.map((r: any) => r.id))
    expect(mine.data.length).toBeGreaterThan(0)
    expect(theirs.data.length).toBeGreaterThan(0)
    for (const request of theirs.data) expect(myIds.has(request.id)).toBe(false)
  })

  it('keeps the reviewer off the requester’s copy', async () => {
    const mine = await json(await SELF.fetch(`${base}/v1/card-requests`, as(token)))
    for (const request of mine.data) {
      expect(request).not.toHaveProperty('reviewedBy')
      expect(request).not.toHaveProperty('requester')
    }
  })

  it('keeps the queue behind an admin credential', async () => {
    expect((await SELF.fetch(`${base}/v1/card-requests/review`)).status).toBe(401)
    // A real session that simply is not an admin: signing in again will not help.
    expect((await SELF.fetch(`${base}/v1/card-requests/review`, as(plainToken))).status).toBe(403)
    expect(
      (await SELF.fetch(`${base}/v1/card-requests/review`, { headers: ADMIN })).status,
    ).toBe(200)
  })

  it('shows the queue who asked', async () => {
    const queue = await json(await SELF.fetch(`${base}/v1/card-requests/review`, { headers: ADMIN }))
    expect(queue.data.length).toBeGreaterThan(0)
    expect(queue.data[0].requester.id).toMatch(/^user_[0-9a-f]{32}$/)
  })
})

describe('withdrawing', () => {
  it('takes a pending request and its prefixes away', async () => {
    const { body } = await submit(cardBody('Withdrawn Product', { bins: ['411999'] }))

    const res = await SELF.fetch(`${base}/v1/card-requests/${body.id}`, as(token, { method: 'DELETE' }))
    expect(res.status).toBe(204)

    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM card_request_bins WHERE request_id = ?',
    )
      .bind(body.id)
      .first<{ n: number }>()
    expect(left?.n).toBe(0)

    const mine = await json(await SELF.fetch(`${base}/v1/card-requests`, as(token)))
    expect(mine.data.some((r: any) => r.id === body.id)).toBe(false)
  })

  it('will not confirm that somebody else’s request exists', async () => {
    const { body } = await submit(cardBody('Not Yours Product'), otherToken)

    const res = await SELF.fetch(`${base}/v1/card-requests/${body.id}`, as(token, { method: 'DELETE' }))
    expect(res.status).toBe(404)
  })
})

describe('approving', () => {
  it('needs to be told which card was added', async () => {
    const { body } = await submit(cardBody('Needs A Card Product'), await freshUser())
    const { res } = await approve(body.id, {})
    expect(res.status).toBe(400)
  })

  it('turns down a card that is not in the catalog', async () => {
    const { body } = await submit(cardBody('Ghost Card Product'), await freshUser())
    const { res } = await approve(body.id, { cardId: 'card_' + '0'.repeat(32) })
    expect(res.status).toBe(400)
  })

  it('APPROVES a card that has no BIN prefixes, and says it is not selectable', async () => {
    // The decision this feature turns on. A card with no prefixes is a
    // supported state, so requiring them here would wedge the queue and push an
    // admin towards inventing one. It is reported, never enforced.
    const { body } = await submit(cardBody('No Prefixes Yet Product'), await freshUser())
    const { res, body: out } = await approve(body.id, { cardId: binlessCard })

    expect(res.status, JSON.stringify(out)).toBe(200)
    expect(out.request.status).toBe('approved')
    expect(out.request.card.id).toBe(binlessCard)
    expect(out.selectable).toBe(false)
  })

  it('records the card on an approved request', async () => {
    const user = await freshUser()
    const { body } = await submit(cardBody('Resolved Product'), user)
    const { res, body: out } = await approve(body.id, { cardId: binCard })

    expect(res.status).toBe(200)
    expect(out.selectable).toBe(true)

    const mine = await json(await SELF.fetch(`${base}/v1/card-requests`, as(user)))
    const seen = mine.data.find((r: any) => r.id === body.id)
    expect(seen.status).toBe('approved')
    expect(seen.card.id).toBe(binCard)
  })

  it('will not resolve a request against a card we retired', async () => {
    const { body } = await submit(cardBody('Retired Resolution Product'), await freshUser())
    const { res, body: out } = await approve(body.id, { cardId: retiredCard })

    expect(res.status).toBe(400)
    expect(out.error.details.join(' ')).toMatch(/deactivated/i)
  })

  it('holds a BIN request open while the card still has no prefixes', async () => {
    // binlessCard has none, so there is nothing this request could have got.
    const { body } = await submit(
      { kind: 'bin', cardId: binlessCard, network: 'visa', bins: ['411777'] },
      await freshUser(),
    )
    const { res } = await approve(body.id)
    // Nothing stops the approval itself -- the gate is existence and active --
    // but the card is honestly reported as still not selectable.
    expect(res.status).toBe(200)
    const out = await json(
      await SELF.fetch(`${base}/v1/card-requests/review?status=approved`, { headers: ADMIN }),
    )
    expect(out.data.find((r: any) => r.id === body.id).card.selectable).toBe(false)
  })

  it('APPROVES a BIN request the admin honoured with a different prefix', async () => {
    // The second decision this feature turns on. The requester guessed 419999;
    // the admin knows the real prefix is already on the card. Refusing here
    // would leave only two exits: fabricate the guess into card_bins, or wedge
    // the queue for ever.
    const { body } = await submit(
      { kind: 'bin', cardId: binCard, network: 'visa', bins: ['419999'] },
      await freshUser(),
    )
    const { res, body: out } = await approve(body.id)

    expect(res.status, JSON.stringify(out)).toBe(200)
    expect(out.request.status).toBe('approved')
  })

  it('will not let an admin quietly point a request at another card', async () => {
    const { body } = await submit({ kind: 'bin', cardId: dualCard, network: 'visa' }, await freshUser())
    const { res, body: out } = await approve(body.id, { cardId: binCard })

    expect(res.status).toBe(400)
    expect(out.error.details.join(' ')).toMatch(/retarget/i)
  })

  it('settles a request once', async () => {
    const { body } = await submit(cardBody('Settled Once Product'), await freshUser())
    expect((await approve(body.id, { cardId: binCard })).res.status).toBe(200)
    expect((await approve(body.id, { cardId: binCard })).res.status).toBe(409)
  })

  it('leaves the catalog exactly as the admin left it', async () => {
    // The regression that matters: PATCH /v1/cards/:id { networks } replaces
    // rather than merges, so an approval that touched the catalog could wipe a
    // card's other prefixes and silently break verification for its holders.
    // Approval writes nothing, and this is what says so.
    const before = await json(
      await SELF.fetch(`${base}/v1/cards/${dualCard}/networks`, { headers: ADMIN }),
    )

    const { body } = await submit(
      { kind: 'bin', cardId: dualCard, network: 'rupay', bins: ['650002'] },
      await freshUser(),
    )
    expect((await approve(body.id)).res.status).toBe(200)

    const after = await json(
      await SELF.fetch(`${base}/v1/cards/${dualCard}/networks`, { headers: ADMIN }),
    )
    expect(after).toEqual(before)
  })
})

describe('who settled it', () => {
  it('records the admin behind a session, and nobody behind the shared token', async () => {
    const bySession = await submit(cardBody('Session Reviewed Product'), await freshUser())
    await approve(
      bySession.body.id,
      { cardId: binCard },
      { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    )

    const byToken = await submit(cardBody('Token Reviewed Product'), await freshUser())
    await approve(byToken.body.id, { cardId: binCard })

    const reviewer = (id: string) =>
      env.DB.prepare('SELECT reviewed_by FROM card_requests WHERE id = ?')
        .bind(id)
        .first<{ reviewed_by: string | null }>()

    expect((await reviewer(bySession.body.id))?.reviewed_by).toMatch(/^user_[0-9a-f]{32}$/)
    // ADMIN_TOKEN identifies nobody, and the column is nullable for exactly this.
    expect((await reviewer(byToken.body.id))?.reviewed_by).toBeNull()
  })
})

describe('rejecting', () => {
  it('insists on a reason', async () => {
    const { body } = await submit(cardBody('Unexplained Rejection Product'), await freshUser())

    const res = await SELF.fetch(`${base}/v1/card-requests/${body.id}/reject`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect((await json(res)).error.details.join(' ')).toMatch(/must say why/i)
  })

  it('shows the requester why', async () => {
    const user = await freshUser()
    const { body } = await submit(cardBody('Explained Rejection Product'), user)

    const res = await SELF.fetch(`${base}/v1/card-requests/${body.id}/reject`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ note: 'That is a debit card, not a credit card.' }),
    })
    expect(res.status, await res.clone().text()).toBe(200)

    const mine = await json(await SELF.fetch(`${base}/v1/card-requests`, as(user)))
    const seen = mine.data.find((r: any) => r.id === body.id)
    expect(seen.status).toBe('rejected')
    expect(seen.reviewNote).toBe('That is a debit card, not a credit card.')
  })

  it('lets the same ask come back once the reason is addressed', async () => {
    const user = await freshUser()
    const first = await submit(cardBody('Second Chance Product'), user)
    await SELF.fetch(`${base}/v1/card-requests/${first.body.id}/reject`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ note: 'Need the issuer spelled out.' }),
    })

    // The dedupe index is partial on status = 'pending', so this is free again.
    const second = await submit(cardBody('Second Chance Product'), user)
    expect(second.res.status, JSON.stringify(second.body)).toBe(201)
  })
})
