/**
 * The admin panel's view of the API.
 *
 * Separate from api.ts because the two want different shapes of the same rows:
 * `toCard` there flattens a card down to what the deck renders and throws away
 * `country`, `type`, `isActive` and the bank's id, all of which are the point
 * here. The transport is shared -- `request` carries the Clerk session token,
 * the error envelope and abort handling, and there is no second copy of any of
 * it.
 *
 * Everything below is admin-guarded server-side. A signed-in non-admin gets a
 * 403, an anonymous caller a 401.
 */

import { request } from './api'

/** Lists all answer in this envelope; `total` ignores pagination. */
export type Page<T> = { data: T[]; total: number }

/**
 * The API caps `limit` at 100 and the panel does not paginate -- it asks for
 * the maximum and tells the user when there is more. Honest and enough: no bank
 * issues 100 cards.
 */
export const ADMIN_PAGE_SIZE = 100

function listQuery(params: { q?: string; includeInactive?: boolean } = {}): string {
  const search = new URLSearchParams()
  if (params.q) search.set('q', params.q)
  if (params.includeInactive) search.set('includeInactive', 'true')
  search.set('limit', String(ADMIN_PAGE_SIZE))
  return search.toString()
}

/* ------------------------------------------------------------------ banks */

export type AdminBank = {
  id: string
  name: string
  isActive: boolean
}

export function listBanks(
  params: { q?: string; includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<Page<AdminBank>> {
  return request<Page<AdminBank>>(`/v1/banks?${listQuery(params)}`, { signal })
}

export function getBank(bankId: string, signal?: AbortSignal): Promise<AdminBank> {
  return request<AdminBank>(`/v1/banks/${bankId}`, { signal })
}

export function createBank(name: string): Promise<AdminBank> {
  return request<AdminBank>('/v1/banks', { method: 'POST', body: JSON.stringify({ name }) })
}

export function updateBank(bankId: string, patch: Partial<Pick<AdminBank, 'name' | 'isActive'>>) {
  return request<AdminBank>(`/v1/banks/${bankId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/**
 * Soft delete: the row stays and its cards stay, they just leave the public
 * catalog. Reactivating is `updateBank(id, { isActive: true })`, which is why
 * the panel calls this Deactivate rather than Delete.
 */
export function deactivateBank(bankId: string): Promise<void> {
  return request<void>(`/v1/banks/${bankId}`, { method: 'DELETE' })
}

/* ------------------------------------------------------------------ cards */

export const CARD_TYPES = ['credit', 'debit', 'charge', 'prepaid'] as const

/** Mirrors the CHECK in migration 0012 and CARD_TYPES in cards/cardTypes.ts. */
export type CardType = (typeof CARD_TYPES)[number]

export type AdminCard = {
  id: string
  name: string
  bank: { id: string; name: string }
  issuer: string
  country: string
  type: CardType
  joiningFee: number
  annualFee: number
  isActive: boolean
  /** True once the card has at least one BIN prefix, i.e. can be verified. */
  selectable: boolean
}

export type AdminCardInput = {
  bankId: string
  name: string
  country: string
  type: CardType
  joiningFee: number
  annualFee: number
  /**
   * The networks the card runs on and the prefixes under each, written in the
   * same call that creates it. `POST /v1/cards` has always accepted this; the
   * panel just never asked for it, so a new card needed a create and then a
   * PATCH. Approving a card request is the caller that wanted one write.
   */
  networks?: { code: string; bins: string[] }[]
}

/**
 * `includeUnselectable` is not optional here and never false.
 *
 * The catalog hides cards with no BIN prefixes from browse, which is right for
 * the picker and exactly wrong for the tool that exists to give them prefixes:
 * 67 of the 100 seeded cards are in that state, and without this flag they
 * would be invisible to the only screen that can fix them.
 */
export function listBankCards(
  bankId: string,
  params: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<Page<AdminCard>> {
  const search = new URLSearchParams({
    includeUnselectable: 'true',
    limit: String(ADMIN_PAGE_SIZE),
  })
  if (params.includeInactive) search.set('includeInactive', 'true')

  return request<Page<AdminCard>>(`/v1/banks/${bankId}/cards?${search}`, { signal })
}

export function getCard(cardId: string, signal?: AbortSignal): Promise<AdminCard> {
  return request<AdminCard>(`/v1/cards/${cardId}`, { signal })
}

export function createCard(input: AdminCardInput): Promise<AdminCard> {
  return request<AdminCard>('/v1/cards', { method: 'POST', body: JSON.stringify(input) })
}

export function updateCard(
  cardId: string,
  patch: Partial<Omit<AdminCardInput, 'bankId'>> & { isActive?: boolean },
): Promise<AdminCard> {
  return request<AdminCard>(`/v1/cards/${cardId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deactivateCard(cardId: string): Promise<void> {
  return request<void>(`/v1/cards/${cardId}`, { method: 'DELETE' })
}

/* ------------------------------------------------- a card's networks + BINs */

/** One network a card runs on, and the prefixes recorded under it. */
export type CardNetwork = {
  /** A network *code*, e.g. 'visa'. Network ids never leave the server. */
  network: string
  /** 6- or 8-digit prefixes, ascending. Empty is a real state. */
  bins: string[]
}

export function listCardNetworks(cardId: string, signal?: AbortSignal): Promise<Page<CardNetwork>> {
  return request<Page<CardNetwork>>(`/v1/cards/${cardId}/networks`, { signal })
}

/**
 * REPLACES a card's whole network and BIN set. There is no merge and no
 * per-network endpoint: whatever is passed here becomes the entire truth, and
 * anything omitted is deleted. Always send the full set, read fresh from
 * `listCardNetworks`.
 */
export function replaceCardNetworks(
  cardId: string,
  networks: { code: string; bins: string[] }[],
): Promise<AdminCard> {
  return request<AdminCard>(`/v1/cards/${cardId}`, {
    method: 'PATCH',
    body: JSON.stringify({ networks }),
  })
}

/**
 * Adds prefixes to a card without destroying the ones already there.
 *
 * THE ONLY SAFE WAY TO ADD A BIN. `replaceCardNetworks` is a full replace whose
 * first act server-side is `DELETE FROM card_bins WHERE card_id = ?` -- all of
 * them, before it looks at what you sent. Passing it one network with one
 * prefix therefore wipes every other network and every other prefix on the
 * card, returns 200, and breaks `POST /v1/verifications` for everyone already
 * holding it, because that route refuses a card with no networks or no
 * prefixes. Read the whole set, merge into it, send it all back.
 *
 * Never call `replaceCardNetworks` directly to add something.
 */
export async function mergeCardBins(
  cardId: string,
  code: string,
  bins: string[],
): Promise<AdminCard> {
  const current = await listCardNetworks(cardId)

  const merged = current.data.map((entry) =>
    entry.network === code
      ? { code: entry.network, bins: [...new Set([...entry.bins, ...bins])].sort() }
      : { code: entry.network, bins: entry.bins },
  )
  if (!merged.some((entry) => entry.code === code)) merged.push({ code, bins: [...bins].sort() })

  return replaceCardNetworks(cardId, merged)
}

/* ------------------------------------------------------- rubric and scores */

export type AdminCriterion = {
  id: string
  name: string
  description: string | null
  weight: number
  isActive: boolean
}

export function listCriteria(
  params: { includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<Page<AdminCriterion>> {
  return request<Page<AdminCriterion>>(`/v1/criteria?${listQuery(params)}`, { signal })
}

/** Derived on read from the weighted average; never stored. */
export type Rating = {
  score: number | null
  max: number
  scoredCriteria: number
  totalCriteria: number
}

export type CardScore = {
  criterion: AdminCriterion
  score: number
}

export type CardScores = { data: CardScore[]; total: number; rating: Rating }

export function getCardScores(cardId: string, signal?: AbortSignal): Promise<CardScores> {
  return request<CardScores>(`/v1/cards/${cardId}/scores`, { signal })
}

/** Replaces the whole score set, same contract as the networks editor. */
export function replaceCardScores(
  cardId: string,
  scores: { criterionId: string; score: number }[],
): Promise<CardScores> {
  return request<CardScores>(`/v1/cards/${cardId}/scores`, {
    method: 'PUT',
    body: JSON.stringify({ scores }),
  })
}

/* --------------------------------------------------------------- networks */

export const BIN_RULE_KINDS = ['glob', 'range'] as const

export type BinRuleKind = (typeof BIN_RULE_KINDS)[number]

/**
 * How a network says which prefixes belong to it. A `glob` is digits, `[`, `]`,
 * `-` and `*` only -- `4*`, `5[1-5]*`. A `range` is two four-digit bounds, low
 * first, compared against the prefix's leading four digits -- `2221-2720`.
 */
export type BinRule = { kind: BinRuleKind; value: string }

export type AdminNetwork = {
  id: string
  code: string
  name: string
  isActive: boolean
  binRules: BinRule[]
}

export function listNetworks(
  params: { q?: string; includeInactive?: boolean } = {},
  signal?: AbortSignal,
): Promise<Page<AdminNetwork>> {
  return request<Page<AdminNetwork>>(`/v1/networks?${listQuery(params)}`, { signal })
}

export function createNetwork(input: {
  code: string
  name: string
  binRules: BinRule[]
}): Promise<AdminNetwork> {
  return request<AdminNetwork>('/v1/networks', { method: 'POST', body: JSON.stringify(input) })
}

/**
 * `binRules` replaces the whole rule set when present, is left untouched when
 * omitted, and is cleared by `[]` -- which makes the network unusable for new
 * BINs until rules come back.
 */
export function updateNetwork(
  networkId: string,
  patch: { code?: string; name?: string; isActive?: boolean; binRules?: BinRule[] },
): Promise<AdminNetwork> {
  return request<AdminNetwork>(`/v1/networks/${networkId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deactivateNetwork(networkId: string): Promise<void> {
  return request<void>(`/v1/networks/${networkId}`, { method: 'DELETE' })
}

/* ---------------------------------------------------------- card requests */

export type RequestKind = 'card' | 'bin'

export type RequestStatus = 'pending' | 'approved' | 'rejected'

export type AdminCardRequest = {
  id: string
  kind: RequestKind
  status: RequestStatus
  card: { id: string; name: string; issuer: string; selectable: boolean } | null
  proposal: { bankId: string | null; issuer: string; name: string; type: CardType | null } | null
  network: string
  bins: string[]
  note: string | null
  reviewNote: string | null
  createdAt: string
  reviewedAt: string | null
  requester: { id: string; handle: string | null }
  /** Null when the review came in over ADMIN_TOKEN, which identifies nobody. */
  reviewedBy: string | null
}

/**
 * The queue. Defaults server-side to pending, which is both the useful view and
 * what keeps it inside ADMIN_PAGE_SIZE -- this is the first admin list that can
 * plausibly outgrow one page.
 */
export function listCardRequests(
  params: { status?: RequestStatus } = {},
  signal?: AbortSignal,
): Promise<Page<AdminCardRequest>> {
  const search = new URLSearchParams({ limit: String(ADMIN_PAGE_SIZE) })
  if (params.status) search.set('status', params.status)

  return request<Page<AdminCardRequest>>(`/v1/card-requests/review?${search}`, { signal })
}

/**
 * Records that a request has been honoured. Writes nothing to the catalog --
 * the card and its prefixes have to exist already, through the endpoints above.
 *
 * `selectable` in the answer is reported, not enforced: a card with no prefixes
 * is approved just the same, and the screen says so rather than the API
 * refusing.
 */
export function approveCardRequest(
  id: string,
  body: { cardId?: string; note?: string } = {},
): Promise<{ request: AdminCardRequest; selectable: boolean }> {
  return request(`/v1/card-requests/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** The note is required: "Declined" with no reason is the worst possible answer. */
export function rejectCardRequest(id: string, note: string): Promise<AdminCardRequest> {
  return request<AdminCardRequest>(`/v1/card-requests/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  })
}
