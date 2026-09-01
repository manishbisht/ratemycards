/**
 * The Workers API client. Everything the app knows about the catalog and about
 * scoring comes through here -- there is no local copy of either, so the two
 * cannot drift.
 */

import type { Card, CardId } from './cards'
import type { CheckoutSuccess } from './razorpayCheckout'
import type { VerificationStatus } from '../state/walletTypes'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL

if (!apiBaseUrl) throw new Error('VITE_API_BASE_URL must be set.')

const BASE_URL = apiBaseUrl.replace(/\/$/, '')

/**
 * Clerk's `getToken` lives behind a React hook, and this module is plain
 * functions with no context to read from. Rather than thread a token through
 * every call site, the app registers a getter once at startup -- see
 * useApiAuth. Left unset, every request goes out anonymous, which is exactly
 * what the public catalog wants.
 *
 * ORDERING TRAP. This is registered from an effect in `App`, and React flushes
 * effects child-first, so any *descendant* that fires an authenticated request
 * from its own mount effect runs while this is still null and goes out
 * anonymous. Callers below App that need a token on mount must pass one
 * explicitly, the way fetchMe does -- `init.headers` is merged last in
 * `request`, so it wins over whatever this resolves to.
 */
let getAuthToken: (() => Promise<string | null>) | null = null

export function setAuthTokenGetter(getter: (() => Promise<string | null>) | null): void {
  getAuthToken = getter
}

async function authHeader(): Promise<Record<string, string>> {
  if (!getAuthToken) return {}

  // A token that cannot be fetched -- expired session, Clerk still loading --
  // is not fatal: the request proceeds anonymously and the API decides.
  const token = await getAuthToken().catch(() => null)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Shape of the API's error envelope. */
type ErrorBody = { error?: { code?: string; message?: string; details?: string[] } }

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /**
   * The per-field problems behind a 400. The API's validators are
   * accumulator-style -- they report every fault at once rather than the first
   * -- and `message` is only ever the generic "The request body is invalid."
   * The admin forms are the consumer: without this, "BIN '999999' is not valid
   * for network 'visa'" never reaches the screen.
   */
  readonly details: string[] | undefined

  constructor(status: number, code: string, message: string, details?: string[]) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = await authHeader()

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...auth, ...init?.headers },
    })
  } catch (err) {
    // A cancelled request is not a failure -- it means a newer one superseded
    // it. Swallowing it here would show a spurious error on every keystroke.
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    // Offline, DNS failure, CORS rejection -- all indistinguishable here, and
    // all mean the same thing to someone looking at the screen.
    throw new ApiError(0, 'network_error', 'Could not reach the server.')
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorBody
    throw new ApiError(
      response.status,
      body.error?.code ?? 'unknown_error',
      body.error?.message ?? `Request failed (${response.status}).`,
      body.error?.details,
    )
  }

  // 204 carries no body, and response.json() would throw on the empty one.
  // The callers that see this return void.
  if (response.status === 204) return undefined as T

  return (await response.json()) as T
}

/* -------------------------------------------------------------- identity */

/**
 * The caller's own row. `isAdmin` is the only signal the app has for whether to
 * let someone into `#/admin`, and it is read from the server rather than from a
 * Clerk claim -- Clerk says who you are, the users table says what you may do.
 */
export type Me = {
  id: string
  email: string | null
  name: string | null
  imageUrl: string | null
  isActive: boolean
  isAdmin: boolean
}

/**
 * `token` exists because this is the bootstrap call: the admin console asks it
 * on mount, from a component below `App`, and child effects flush before the
 * parent effect that registers the shared token getter. Passing the token in
 * makes the call independent of that ordering rather than dependent on where
 * in the tree it happens to be made. Omit it once the app is running and the
 * registered getter is used as normal.
 */
export function fetchMe(signal?: AbortSignal, token?: string | null): Promise<Me> {
  return request<Me>('/v1/users/me', {
    signal,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  })
}

/* ------------------------------------------------------------------ cards */

/** Present only when the request carried a session token. */
type ApiCardWallet = {
  inWallet: boolean
  verificationStatus: VerificationStatus
  verifiedAt: string | null
}

type ApiCard = {
  id: string
  name: string
  issuer: string
  bank: { id: string; name: string }
  country: string
  joiningFee: number
  annualFee: number
  isActive: boolean
  selectable: boolean
  wallet?: ApiCardWallet
}

/**
 * `short` is derived rather than stored: the API models a card as a product
 * plus a bank, while the deck tiles want a two-line label.
 */
function toCard(card: ApiCard): Card {
  return {
    id: card.id,
    name: card.name,
    issuer: card.issuer,
    short: `${card.bank.name}\n${card.name}`,
    joiningFee: card.joiningFee,
    annualFee: card.annualFee,
    selectable: card.selectable,
  }
}

type ListResponse = { data: ApiCard[]; total: number }

export type CardPage = { cards: Card[]; total: number }

/**
 * `total` ignores pagination, so a caller can compare it against how many cards
 * it holds to know whether another page exists. The API caps `limit` at 100,
 * which is why anything wanting the whole catalog has to page.
 */
export async function fetchCards(
  params: {
    q?: string
    ids?: CardId[]
    limit?: number
    offset?: number
    /** Opts out of the server's BIN gate. See catalogSlice's loadCatalog. */
    includeUnselectable?: boolean
  } = {},
  signal?: AbortSignal,
): Promise<CardPage> {
  const search = new URLSearchParams()
  if (params.q) search.set('q', params.q)
  if (params.ids) search.set('ids', params.ids.join(','))
  search.set('limit', String(params.limit ?? 50))
  if (params.offset) search.set('offset', String(params.offset))
  if (params.includeUnselectable) search.set('includeUnselectable', 'true')

  const body = await request<ListResponse>(`/v1/cards?${search}`, { signal })
  return { cards: body.data.map(toCard), total: body.total }
}

/* ----------------------------------------------------------------- wallet */

export type Tier = { min: number; name: string; color: string }

/** Only the aggregate: the API publishes no per-card rating. */
export type WalletScore = {
  score: number
  maxScore: number
  tier: Tier
  cardCount: number
  /** Ids the API did not recognise, so stale local state can be pruned. */
  unknownIds: CardId[]
}

/**
 * Scores a set of cards without storing anything. The wallet lives in this
 * browser until accounts exist; the server only does the arithmetic.
 */
export function previewWallet(cardIds: CardId[], signal?: AbortSignal): Promise<WalletScore> {
  return request<WalletScore>('/v1/wallet/preview', {
    method: 'POST',
    body: JSON.stringify({ cardIds }),
    signal,
  })
}

export const EMPTY_SCORE: WalletScore = {
  score: 0,
  maxScore: 3000,
  tier: { min: 0, name: 'Beginner', color: '#34D399' },
  cardCount: 0,
  unknownIds: [],
}

/* --------------------------------------------------------- stored wallets */

/**
 * A card in the signed-in wallet, as the API returns it: the card itself plus
 * this holder's state on it. Anonymous visitors never see these -- their wallet
 * is still just a list of ids in this browser.
 */
export type WalletCard = {
  card: Card
  verificationStatus: VerificationStatus
  verifiedAt: string | null
}

export type StoredWallet = {
  cards: WalletCard[]
  score: WalletScore
}

type ApiWalletCard = {
  card: ApiCard
  verificationStatus: VerificationStatus
  verifiedAt: string | null
}

type ApiStoredWallet = { cards: ApiWalletCard[]; score: WalletScore }

function toStoredWallet(body: ApiStoredWallet): StoredWallet {
  return {
    cards: body.cards.map((entry) => ({
      card: toCard(entry.card),
      verificationStatus: entry.verificationStatus,
      verifiedAt: entry.verifiedAt,
    })),
    score: body.score,
  }
}

export async function fetchWallet(signal?: AbortSignal): Promise<StoredWallet> {
  return toStoredWallet(await request<ApiStoredWallet>('/v1/wallet', { signal }))
}

/**
 * Folds this browser's picks into the account's wallet at sign-in. The server
 * unions rather than overwrites, so a card already held keeps the verification
 * it earned on whatever device earned it.
 */
export async function mergeWallet(cardIds: CardId[]): Promise<StoredWallet> {
  return toStoredWallet(
    await request<ApiStoredWallet>('/v1/wallet/merge', {
      method: 'POST',
      body: JSON.stringify({ cardIds }),
    }),
  )
}

export async function addWalletCard(cardId: CardId): Promise<StoredWallet> {
  return toStoredWallet(
    await request<ApiStoredWallet>(`/v1/wallet/cards/${cardId}`, { method: 'PUT' }),
  )
}

export function removeWalletCard(cardId: CardId): Promise<void> {
  return request<void>(`/v1/wallet/cards/${cardId}`, { method: 'DELETE' })
}

export async function setWalletCardStatus(
  cardId: CardId,
  status: VerificationStatus,
): Promise<StoredWallet> {
  return toStoredWallet(
    await request<ApiStoredWallet>(`/v1/wallet/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  )
}

/* ----------------------------------------------------- card verification */

export type VerificationOrder = {
  verificationId: string
  keyId: string
  orderId: string
  amount: number
  currency: string
  cardName: string
  issuer: string
  allowed: { iins: string[]; networks: string[] }
}

/**
 * Mints the ₹1 order Checkout needs, and hands back the BIN list to narrow the
 * modal to this card's own plastic.
 */
export function startVerification(cardId: CardId): Promise<VerificationOrder> {
  return request<VerificationOrder>('/v1/verifications', {
    method: 'POST',
    body: JSON.stringify({ cardId }),
  })
}

export type VerificationResult = {
  verificationId: string
  status: 'created' | 'verified' | 'mismatched' | 'failed'
  releaseState: 'pending' | 'voided' | 'refunded'
  card: {
    network: string | null
    last4: string | null
    type: string | null
    issuer: string | null
  }
  reason?: string
}

/**
 * Hands Checkout's three callback fields to the server, which verifies the
 * signature, checks the card that actually paid against the one being claimed,
 * and gives the rupee back either way.
 *
 * A card that does not match answers 422 with a `reason`, which `request`
 * raises as an ApiError -- so a mismatch is a rejection, not a silent pass.
 */
export function confirmVerification(
  verificationId: string,
  payload: CheckoutSuccess,
): Promise<VerificationResult> {
  return request<VerificationResult>(`/v1/verifications/${verificationId}/confirm`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
