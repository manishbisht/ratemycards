import { Hono } from 'hono'
import { adminAuth } from '../../http/adminAuth'
import { requireUser } from '../../http/clerkAuth'
import { ApiError, readJsonBody } from '../../http/errors'
import { parseLimit, parseOffset } from '../../http/params'
import type { AppEnv, AuthUser } from '../../env'
import { getBank, listBanks } from '../banks/queries'
import { getCard, listCards } from '../cards/queries'
import { listNetworksForValidation } from '../networks/queries'
import {
  approveRequest,
  countOpenRequests,
  createRequest,
  deleteRequest,
  getRequest,
  listRequestsForReview,
  listRequestsForUser,
  rejectRequest,
} from './queries'
import type { ResolvedIssuer } from './queries'
import { MAX_OPEN_REQUESTS, isRequestStatus, toPublicCardRequest } from './cardRequestTypes'
import type { AdminCardRequest, CardRequestFilters } from './cardRequestTypes'
import { validateApprove, validateCardRequestInput, validateReject } from './validate'

/**
 * Asking the catalog for a card it does not carry, or for the BIN prefixes a
 * card it does carry is missing.
 *
 * NOTHING HERE WRITES TO THE CATALOG. An admin creates the bank, the card and
 * the prefixes through /v1/banks and /v1/cards -- which already validate all of
 * that against networks/binRules.ts -- and then calls approve, which records
 * that it happened. Approval is bookkeeping over work already done, and its
 * check is a guard rail against a typo, not a transaction. See migration 0016.
 *
 * The gate is deliberately existence-and-active, never selectability. A card
 * with no prefixes is a supported state -- two thirds of the seeded catalog is
 * in it -- so requiring them would wedge the queue whenever the data is not to
 * hand, and push an admin towards inventing a prefix to clear it, straight into
 * the table the rupee verification matches against. The response reports
 * `selectable` instead and lets the screen say so in words.
 */
export const cardRequestRoutes = new Hono<AppEnv>()

function callerId(user: AuthUser | undefined): string {
  if (!user) throw ApiError.unauthorized('A valid session token is required.')
  return user.id
}

/**
 * Below MAX_LIMIT on purpose. Every row may name a distinct card, and resolving
 * them binds one parameter each in `listCards`; 50 is the same headroom MAX_IDS
 * leaves for the same reason.
 */
const MAX_REQUEST_PAGE = 50

function readFilters(c: { req: { query: (k: string) => string | undefined } }): CardRequestFilters {
  const raw = c.req.query('status')
  if (raw !== undefined && !isRequestStatus(raw)) {
    throw ApiError.validation(["status must be 'pending', 'approved' or 'rejected'."])
  }

  return {
    status: raw,
    limit: Math.min(parseLimit(c.req.query('limit')), MAX_REQUEST_PAGE),
    offset: parseOffset(c.req.query('offset')),
  }
}

/**
 * Which issuer a 'card' request is really about.
 *
 * A typed name is matched case-insensitively against the banks we carry and
 * adopted when it hits, so "hdfc bank" does not open a request against a second
 * HDFC. Worth knowing why this is load-bearing: idx_banks_name in 0001 is a
 * plain UNIQUE under SQLite's default BINARY collation, so 'HDFC' and 'hdfc'
 * can already both exist as banks -- and this feature hands people a keyboard
 * pointed straight at that. Normalising here stops it getting worse; fixing the
 * index is a separate migration and a separate decision.
 */
async function resolveIssuer(
  db: D1Database,
  bankId: string | undefined,
  issuer: string | undefined,
): Promise<ResolvedIssuer> {
  if (bankId !== undefined) {
    const bank = await getBank(db, bankId)
    if (!bank || !bank.isActive) throw ApiError.notFound(`Bank '${bankId}'`)
    return { bankId: bank.id, bankName: bank.name }
  }

  // Unreachable without an issuer: the validator requires one when no id came
  // with the request.
  if (issuer === undefined) throw ApiError.validation(['bankId or issuer is required.'])

  const { banks } = await listBanks(db, { q: issuer, includeInactive: false, limit: 50, offset: 0 })
  const match = banks.find((bank) => bank.name.toLowerCase() === issuer.toLowerCase())

  return match ? { bankId: match.id, bankName: match.name } : { bankId: null, bankName: issuer }
}

cardRequestRoutes.post('/', requireUser, async (c) => {
  const networks = await listNetworksForValidation(c.env.DB)
  const result = validateCardRequestInput(await readJsonBody(c), networks)
  if (!result.ok) throw ApiError.validation(result.errors)

  const input = result.value
  const userId = callerId(c.get('user'))

  // The partial unique indexes only stop exact repeats. This is the flood guard.
  if ((await countOpenRequests(c.env.DB, userId)) >= MAX_OPEN_REQUESTS) {
    throw ApiError.conflict(
      `You have ${MAX_OPEN_REQUESTS} requests waiting for review. Withdraw one to make room.`,
    )
  }

  let issuer: ResolvedIssuer = { bankId: null, bankName: null }

  if (input.kind === 'bin') {
    const card = await getCard(c.env.DB, input.cardId as string)
    // getCard resolves inactive cards on purpose, so retired ones are excluded
    // here rather than trusted: there is nothing to ask for on a card we no
    // longer carry.
    if (!card || !card.isActive) throw ApiError.notFound(`Card '${input.cardId}'`)
  } else {
    issuer = await resolveIssuer(c.env.DB, input.bankId, input.issuer)

    // When the issuer resolved, the same conflict an admin would hit two steps
    // later is knowable now -- idx_cards_bank_name makes (bank, name) the key.
    // Answering it here turns a whole class of requests into zero admin work.
    if (issuer.bankId) {
      const name = (input.cardName as string).toLowerCase()
      const { cards } = await listCards(c.env.DB, {
        bankId: issuer.bankId,
        q: input.cardName,
        includeInactive: true,
        includeUnselectable: true,
        limit: MAX_REQUEST_PAGE,
        offset: 0,
      })
      const existing = cards.find((card) => card.name.toLowerCase() === name)
      if (existing) {
        throw ApiError.conflict(
          `'${existing.name}' is already in the catalog under ${issuer.bankName}.`,
        )
      }
    }
  }

  const created = await createRequest(c.env.DB, userId, input, issuer)

  c.header('Location', `/v1/card-requests/${created.id}`)
  return c.json(toPublicCardRequest(created), 201)
})

cardRequestRoutes.get('/', requireUser, async (c) => {
  const userId = callerId(c.get('user'))
  const { requests, total } = await listRequestsForUser(c.env.DB, userId, readFilters(c))

  return c.json({ data: requests.map(toPublicCardRequest), total })
})

/**
 * The review queue. Declared before the `:id` routes below for readability --
 * there is deliberately no `GET /:id` for it to collide with, because both
 * lists already carry everything either audience needs.
 */
cardRequestRoutes.get('/review', adminAuth, async (c) => {
  const filters = readFilters(c)
  const { requests, total } = await listRequestsForReview(c.env.DB, {
    ...filters,
    // The queue is a queue: pending unless asked otherwise. This is also what
    // keeps it inside ADMIN_PAGE_SIZE, since the console does not paginate.
    status: filters.status ?? 'pending',
  })

  return c.json({ data: requests, total })
})

cardRequestRoutes.delete('/:id', requireUser, async (c) => {
  const userId = callerId(c.get('user'))
  const id = c.req.param('id')

  // Scoped to the caller, so somebody else's id is a 404 and never confirms
  // that the row exists.
  const request = await getRequest(c.env.DB, id, userId)
  if (!request) throw ApiError.notFound(`Request '${id}'`)
  if (request.status !== 'pending') {
    throw ApiError.conflict('That request has already been reviewed.')
  }

  await deleteRequest(c.env.DB, id, userId)
  return c.body(null, 204)
})

/** Who to record as the reviewer -- nobody, on the ADMIN_TOKEN path. */
function reviewerId(user: AuthUser | undefined): string | null {
  return user?.id ?? null
}

async function loadPending(db: D1Database, id: string): Promise<AdminCardRequest> {
  const request = await getRequest(db, id)
  if (!request) throw ApiError.notFound(`Request '${id}'`)
  if (request.status !== 'pending') {
    throw ApiError.conflict('That request has already been reviewed.')
  }
  return request
}

cardRequestRoutes.post('/:id/approve', adminAuth, async (c) => {
  const result = validateApprove(await readJsonBody(c).catch(() => ({})))
  if (!result.ok) throw ApiError.validation(result.errors)

  const id = c.req.param('id')
  const request = await loadPending(c.env.DB, id)

  let cardId: string
  if (request.kind === 'bin') {
    if (!request.card) throw ApiError.notFound(`The card request '${id}' targets`)
    // An admin must not be able to quietly point a request at a different card
    // than the person asked about.
    if (result.value.cardId && result.value.cardId !== request.card.id) {
      throw ApiError.validation([
        'This request names a card already; cardId cannot be used to retarget it.',
      ])
    }
    cardId = request.card.id
  } else {
    if (!result.value.cardId) {
      throw ApiError.validation(['cardId is required: name the card you added to the catalog.'])
    }
    cardId = result.value.cardId
  }

  const card = await getCard(c.env.DB, cardId)
  if (!card) throw ApiError.validation([`Card '${cardId}' is not in the catalog.`])
  if (!card.isActive) {
    // getCard resolves inactive cards deliberately, so this has to be asked
    // rather than assumed -- approving against a soft-deleted card would leave
    // the requester with a card nothing can ever show them.
    throw ApiError.validation([`'${card.name}' is deactivated, so it cannot resolve a request.`])
  }

  const settled = await approveRequest(c.env.DB, id, {
    cardId,
    reviewedBy: reviewerId(c.get('user')),
    note: result.value.note ?? null,
  })
  if (!settled) throw ApiError.conflict('That request has already been reviewed.')

  const updated = await getRequest(c.env.DB, id)
  // Reported, never enforced: a card with no prefixes is approved just the same,
  // and this is what lets the console and the requester's list say that plainly.
  return c.json({ request: updated, selectable: card.selectable })
})

cardRequestRoutes.post('/:id/reject', adminAuth, async (c) => {
  const result = validateReject(await readJsonBody(c))
  if (!result.ok) throw ApiError.validation(result.errors)

  const id = c.req.param('id')
  await loadPending(c.env.DB, id)

  const settled = await rejectRequest(c.env.DB, id, {
    reviewedBy: reviewerId(c.get('user')),
    note: result.value.note,
  })
  if (!settled) throw ApiError.conflict('That request has already been reviewed.')

  return c.json(await getRequest(c.env.DB, id))
})
