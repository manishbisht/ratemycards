/**
 * Asking the catalog for a card it does not carry, or for the BIN prefixes a
 * card it does carry is missing.
 *
 * The shapes here match the API's exactly, so unlike `toCard` in api.ts there
 * is nothing to map -- a mapper would be ceremony over an identity function.
 * What does live here is the copy, because the honest reading of a settled
 * request is not obvious from its status alone: see `requestNote`.
 */

export type RequestKind = 'card' | 'bin'

export type RequestStatus = 'pending' | 'approved' | 'rejected'

/** The catalog card a request concerns: the target on 'bin', the result on 'card'. */
export type RequestCard = {
  id: string
  name: string
  issuer: string
  /** False while the card has no BIN prefixes, i.e. cannot be verified yet. */
  selectable: boolean
}

export type CardProposal = {
  bankId: string | null
  issuer: string
  name: string
  type: string | null
}

export type CardRequest = {
  id: string
  kind: RequestKind
  status: RequestStatus
  card: RequestCard | null
  proposal: CardProposal | null
  network: string
  bins: string[]
  note: string | null
  reviewNote: string | null
  createdAt: string
  reviewedAt: string | null
}

export type CardRequestInput = {
  kind: RequestKind
  cardId?: string
  bankId?: string
  issuer?: string
  cardName?: string
  network: string
  bins?: string[]
  note?: string
}

/** One network somebody can say their card runs on. */
export type NetworkOption = { code: string; name: string }

/**
 * One bank somebody can file a request against.
 *
 * A request names a bank by id, not by typing its name: the queue is only worth
 * working if two people asking about the same issuer produce the same issuer.
 * It also means the display name comes from the catalog row rather than from
 * whatever was typed.
 */
export type BankOption = { id: string; name: string }

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  pending: 'Waiting',
  approved: 'Added',
  rejected: 'Declined',
}

/** The same palette the verification statuses use, for the same three moods. */
export const REQUEST_STATUS_COLOR: Record<RequestStatus, string> = {
  pending: '#22D3EE',
  approved: '#34D399',
  rejected: '#F87171',
}

/** What was asked for, in one line. */
export function requestTitle(request: CardRequest): string {
  if (request.kind === 'bin') return request.card?.name ?? 'A card'
  return request.proposal ? `${request.proposal.issuer} ${request.proposal.name}` : 'A new card'
}

/**
 * What the status actually means for this person.
 *
 * The approved-but-not-selectable line is the whole reason this function exists
 * rather than a second lookup table. Approval means an admin added the card;
 * it does not mean the card can be verified yet, because a card with no BIN
 * prefixes stays out of the picker. Saying "Added" and stopping would be a
 * small lie to the one person who cared enough to ask.
 */
export function requestNote(request: CardRequest): string {
  switch (request.status) {
    case 'pending':
      return request.kind === 'bin'
        ? 'We are checking the prefixes you sent.'
        : 'We are checking this card against the catalog.'

    case 'approved':
      if (request.card && !request.card.selectable) {
        return 'Added to the catalog. It will show up once we have its BIN prefixes — that part is still to come.'
      }
      return request.kind === 'bin'
        ? 'Done. You can verify this card now.'
        : 'Added to the catalog. You can pick it in your wallet now.'

    case 'rejected':
      return request.reviewNote ?? 'We could not add this one.'
  }
}
