import { SELF, env } from 'cloudflare:test'
import { Webhook } from 'standardwebhooks'
import { describe, expect, it } from 'vitest'

/**
 * The Clerk webhook: the primary way a user row appears, with the upsert in
 * requireUser as its backstop.
 *
 * A *write* file, for the same reason as walletPersistence.test.ts -- it
 * inserts users, and storage isolation is per file.
 *
 * The payloads are signed for real with the same Standard Webhooks scheme
 * Clerk uses, because the signature is the entire authentication on this route.
 * A test that stubbed it would be testing nothing that matters.
 */

const base = 'http://api.test'
const SIGNING_SECRET = 'whsec_cmF0ZW15Y2FyZHMtdGVzdC13ZWJob29rLXNlY3JldCE='

async function send(payload: unknown, options: { secret?: string; id?: string } = {}) {
  const body = JSON.stringify(payload)
  const timestamp = new Date()
  const id = options.id ?? `msg_${crypto.randomUUID()}`

  // The secret carries a `whsec_` prefix that the signer does not want.
  const webhook = new Webhook((options.secret ?? SIGNING_SECRET).replace(/^whsec_/, ''))
  const signature = webhook.sign(id, timestamp, body)

  return SELF.fetch(`${base}/v1/webhooks/clerk`, {
    method: 'POST',
    headers: signedHeaders(id, timestamp, signature),
    body,
  })
}

/**
 * Clerk signs with Standard Webhooks but still sends the older `svix-*` header
 * names, and verifyWebhook requires exactly those -- it maps them to the
 * standard names itself. Sending `webhook-*` here would fail verification for a
 * reason that has nothing to do with the signature.
 */
function signedHeaders(id: string, timestamp: Date, signature: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'svix-id': id,
    'svix-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
    'svix-signature': signature,
  }
}

function userCreated(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'user.created',
    object: 'event',
    data: {
      id,
      first_name: 'Grace',
      last_name: 'Hopper',
      username: null,
      image_url: 'https://img.example/grace.png',
      primary_email_address_id: 'idn_1',
      email_addresses: [
        { id: 'idn_0', email_address: 'secondary@example.com' },
        { id: 'idn_1', email_address: 'grace@example.com' },
      ],
      ...overrides,
    },
  }
}

async function userRow(clerkId: string) {
  return env.DB.prepare('SELECT id, email, name, image_url, is_active FROM users WHERE clerk_id = ?')
    .bind(clerkId)
    .first<{ id: string; email: string; name: string; image_url: string; is_active: number }>()
}

describe('signature verification', () => {
  it('rejects an unsigned request', async () => {
    const res = await SELF.fetch(`${base}/v1/webhooks/clerk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userCreated('clerk_unsigned')),
    })

    expect(res.status).toBe(401)
    expect(await userRow('clerk_unsigned')).toBeNull()
  })

  it('rejects a payload signed with the wrong secret', async () => {
    const wrong = 'whsec_' + btoa('some-other-secret-entirely-abcdef')
    const res = await send(userCreated('clerk_wrongsecret'), { secret: wrong })

    expect(res.status).toBe(401)
    expect(await userRow('clerk_wrongsecret')).toBeNull()
  })

  it('rejects a body altered after signing', async () => {
    const body = JSON.stringify(userCreated('clerk_tampered'))
    const timestamp = new Date()
    const id = `msg_${crypto.randomUUID()}`
    const signature = new Webhook(SIGNING_SECRET.replace(/^whsec_/, '')).sign(id, timestamp, body)

    const res = await SELF.fetch(`${base}/v1/webhooks/clerk`, {
      method: 'POST',
      headers: signedHeaders(id, timestamp, signature),
      body: body.replace('clerk_tampered', 'clerk_swapped-in'),
    })

    expect(res.status).toBe(401)
    expect(await userRow('clerk_swapped-in')).toBeNull()
  })
})

describe('user events', () => {
  it('creates a row from user.created', async () => {
    expect((await send(userCreated('clerk_grace'))).status).toBe(200)

    const row = await userRow('clerk_grace')
    expect(row?.name).toBe('Grace Hopper')
    expect(row?.image_url).toBe('https://img.example/grace.png')
    expect(row?.is_active).toBe(1)
  })

  /** The array is not ordered, so the primary is picked by id, not position. */
  it('takes the primary email rather than the first listed', async () => {
    expect((await userRow('clerk_grace'))?.email).toBe('grace@example.com')
  })

  it('falls back to the username when there is no name', async () => {
    await send(userCreated('clerk_nameless', { first_name: null, last_name: null, username: 'amazing_grace' }))
    expect((await userRow('clerk_nameless'))?.name).toBe('amazing_grace')
  })

  it('updates in place rather than inserting a second row', async () => {
    const before = await userRow('clerk_grace')

    await send({
      ...userCreated('clerk_grace', { first_name: 'Rear Admiral', last_name: 'Hopper' }),
      type: 'user.updated',
    })

    const after = await userRow('clerk_grace')
    expect(after?.id).toBe(before?.id)
    expect(after?.name).toBe('Rear Admiral Hopper')

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE clerk_id = ?')
      .bind('clerk_grace')
      .first<{ n: number }>()
    expect(count?.n).toBe(1)
  })

  /**
   * A sparser event must not blank what a richer one already established --
   * a session token carries fewer claims than a webhook payload does.
   */
  it('keeps a known field when a later event omits it', async () => {
    await send({
      ...userCreated('clerk_grace', { image_url: null }),
      type: 'user.updated',
    })

    expect((await userRow('clerk_grace'))?.image_url).toBe('https://img.example/grace.png')
  })

  it('soft-deletes on user.deleted rather than removing the row', async () => {
    await send({ type: 'user.deleted', object: 'event', data: { id: 'clerk_grace', deleted: true } })

    const row = await userRow('clerk_grace')
    expect(row).not.toBeNull()
    expect(row?.is_active).toBe(0)
  })

  it('reactivates the same row when the user returns', async () => {
    const deleted = await userRow('clerk_grace')

    await send(userCreated('clerk_grace'))

    const back = await userRow('clerk_grace')
    expect(back?.id).toBe(deleted?.id)
    expect(back?.is_active).toBe(1)
  })

  /** A 4xx would make Clerk retry an event we are never going to want. */
  it('acknowledges event types it does not handle', async () => {
    const res = await send({
      type: 'session.created',
      object: 'event',
      data: { id: 'sess_1', user_id: 'clerk_grace' },
    })

    expect(res.status).toBe(200)
  })
})
