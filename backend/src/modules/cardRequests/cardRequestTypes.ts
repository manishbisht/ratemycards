import { generateId, idPattern } from '../../http/ids'
import type { CardType } from '../cards/cardTypes'

export const CARD_REQUEST_ID_PREFIX = 'creq'
export const CARD_REQUEST_ID_PATTERN = idPattern(CARD_REQUEST_ID_PREFIX)

export function generateCardRequestId(): string {
  return generateId(CARD_REQUEST_ID_PREFIX)
}

/**
 * 'card' asks for a product the catalog does not carry. 'bin' asks for prefixes
 * on a product it does. Mirrors the CHECK in migration 0016.
 */
export const REQUEST_KINDS = ['card', 'bin'] as const
export type CardRequestKind = (typeof REQUEST_KINDS)[number]

export function isRequestKind(value: unknown): value is CardRequestKind {
  return typeof value === 'string' && (REQUEST_KINDS as readonly string[]).includes(value)
}

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const
export type CardRequestStatus = (typeof REQUEST_STATUSES)[number]

export function isRequestStatus(value: unknown): value is CardRequestStatus {
  return typeof value === 'string' && (REQUEST_STATUSES as readonly string[]).includes(value)
}

/**
 * How many requests one person may have open at once.
 *
 * The two partial unique indexes in 0016 only stop *exact* repeats; 'Infinia 1',
 * 'Infinia 2', 'Infinia 3' sail straight past them. This is the actual flood
 * guard, and `DELETE /v1/card-requests/:id` is the release valve that keeps it
 * from stranding someone who mistyped.
 */
export const MAX_OPEN_REQUESTS = 10

/**
 * The catalog card a request concerns: the target on a 'bin' request, the
 * result on a 'card' one.
 *
 * `selectable` is the soft half of the approve gate. Approval requires the card
 * to exist and be active, never to have prefixes -- so this is what lets a
 * screen say "added, it will appear once we have its BIN prefixes" instead of
 * the API pretending the distinction does not exist.
 */
export type RequestCard = {
  id: string
  name: string
  issuer: string
  selectable: boolean
}

/** What a 'card' request proposes. Null on a 'bin' request. */
export type CardProposal = {
  /** Set when the requester's issuer matched one we already carry. */
  bankId: string | null
  issuer: string
  name: string
  type: CardType | null
}

export type CardRequest = {
  id: string
  kind: CardRequestKind
  status: CardRequestStatus
  card: RequestCard | null
  proposal: CardProposal | null
  /** A network code ('visa'), never an id. */
  network: string
  /** The prefixes the requester proposed. A claim, not catalog truth. */
  bins: string[]
  note: string | null
  reviewNote: string | null
  createdAt: string
  reviewedAt: string | null
}

/**
 * The review queue's view. Adds who asked and who settled it -- neither of
 * which belongs in the requester's own copy.
 */
export type AdminCardRequest = CardRequest & {
  requester: { id: string; handle: string | null }
  /**
   * NULL when the review came in over ADMIN_TOKEN, which identifies nobody. See
   * the note in migration 0016.
   */
  reviewedBy: string | null
}

/**
 * The one door out to a requester.
 *
 * Built by naming every field rather than spreading and deleting, the same
 * discipline `toPublicCard` and `toPublicProfile` keep: a field added to
 * AdminCardRequest later must be named here before it can reach a user, so the
 * default for anything new is private.
 */
export function toPublicCardRequest(request: AdminCardRequest): CardRequest {
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    card: request.card,
    proposal: request.proposal,
    network: request.network,
    bins: request.bins,
    note: request.note,
    reviewNote: request.reviewNote,
    createdAt: request.createdAt,
    reviewedAt: request.reviewedAt,
  }
}

export type CardRequestInput = {
  kind: CardRequestKind
  /** kind='bin' only. */
  cardId?: string
  /** kind='card' only. `bankId` is resolved by the route, not sent as gospel. */
  bankId?: string
  issuer?: string
  cardName?: string
  cardType?: CardType
  network: string
  bins: string[]
  note?: string
}

export type CardRequestFilters = {
  status?: CardRequestStatus
  limit: number
  offset: number
}
