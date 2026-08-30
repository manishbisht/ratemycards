/**
 * The Workers API client. Everything the app knows about the catalog and about
 * scoring comes through here -- there is no local copy of either, so the two
 * cannot drift.
 */

import type { Card, CardId } from './cards'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL

if (!apiBaseUrl) throw new Error('VITE_API_BASE_URL must be set.')

const BASE_URL = apiBaseUrl.replace(/\/$/, '')

/** Shape of the API's error envelope. */
type ErrorBody = { error?: { code?: string; message?: string; details?: string[] } }

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
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
    )
  }

  return (await response.json()) as T
}

/* ------------------------------------------------------------------ cards */

type ApiCard = {
  id: string
  name: string
  issuer: string
  bank: { id: string; name: string }
  country: string
  joiningFee: number
  annualFee: number
  isActive: boolean
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
  }
}

type ListResponse = { data: ApiCard[]; total: number }

export type CardPage = { cards: Card[]; total: number }

export async function fetchCards(
  params: { q?: string; ids?: CardId[]; limit?: number } = {},
  signal?: AbortSignal,
): Promise<CardPage> {
  const search = new URLSearchParams()
  if (params.q) search.set('q', params.q)
  if (params.ids) search.set('ids', params.ids.join(','))
  search.set('limit', String(params.limit ?? 50))

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
