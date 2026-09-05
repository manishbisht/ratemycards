import { BANK_ID_PATTERN } from '../banks/bankTypes'
import { CARD_ID_PATTERN, CARD_TYPES, isCardType } from '../cards/cardTypes'
import type { CardType } from '../cards/cardTypes'
import { checkId, checkText, isPlainObject, rejectClientId } from '../../http/validators'
import { matchesBinRules } from '../networks/binRules'
import type { NetworkForValidation } from '../networks/queries'
import { isRequestKind } from './cardRequestTypes'
import type { CardRequestInput } from './cardRequestTypes'

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/**
 * How many prefixes one request may carry.
 *
 * SQLite cannot count rows in a CHECK, so unlike every other rule in migration
 * 0016 this one has no backstop underneath it. It is the only thing standing
 * between a request and an unbounded child-table insert.
 */
export const MAX_REQUEST_BINS = 10

/** Matches the CHECK on card_request_bins.bin_prefix in migration 0016. */
const BIN_PATTERN = /^(\d{6}|\d{8})$/

const ALL_DIGITS = /^\d+$/

/** Matches the CHECKs on note and review_note in migration 0016. */
const MAX_NOTE = 280

/**
 * The prefixes a requester proposed.
 *
 * Rule-checked against the network they named, not just shape-checked: the form
 * makes them pick a network from the ones we carry, so 'visa' with a 5xxxxx
 * prefix is a mistake worth catching at the form rather than three steps later
 * in an admin's lap.
 *
 * The long-digit branch is not a nicety. This is the one field in the product
 * that asks a person to read digits off their own card, inside an app that also
 * runs a card-verification flow -- an interaction indistinguishable from
 * phishing training. Somebody pasting a full PAN needs to be told exactly what
 * went wrong, and the value must never reach a log.
 */
function checkBins(
  value: unknown,
  network: NetworkForValidation | undefined,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push('bins must be an array.')
    return undefined
  }
  if (value.length > MAX_REQUEST_BINS) {
    errors.push(`A request may propose at most ${MAX_REQUEST_BINS} BIN prefixes.`)
    return undefined
  }

  const bins: string[] = []
  for (const raw of value) {
    if (typeof raw === 'string' && ALL_DIGITS.test(raw) && raw.length > 8) {
      // Deliberately does not echo the value back.
      errors.push(
        'A BIN prefix is the first 6 or 8 digits of a card number only. Never enter your full card number.',
      )
      continue
    }
    if (typeof raw !== 'string' || !BIN_PATTERN.test(raw)) {
      errors.push(`BIN '${String(raw)}' must be 6 or 8 digits.`)
      continue
    }
    // An unknown network already produced its own error; do not pile a second
    // one onto every prefix under it.
    if (network && network.binRules.length > 0 && !matchesBinRules(raw, network.binRules)) {
      errors.push(`BIN '${raw}' is not valid for network '${network.code}'.`)
      continue
    }
    if (!bins.includes(raw)) bins.push(raw)
  }

  return bins
}

/**
 * The network the requester named. Unlike cards/validate.ts this rejects an
 * inactive network outright rather than distinguishing it from an unknown one:
 * the difference matters to an admin editing the catalog and means nothing to
 * somebody filling in a form.
 */
function checkNetwork(
  value: unknown,
  known: NetworkForValidation[],
  errors: string[],
): NetworkForValidation | undefined {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!code) {
    errors.push('network is required.')
    return undefined
  }
  const network = known.find((n) => n.code === code && n.isActive)
  if (!network) {
    errors.push(`'${code}' is not a network we carry.`)
    return undefined
  }
  return network
}

function checkCardType(value: unknown, errors: string[]): CardType | undefined {
  if (!isCardType(value)) {
    errors.push(`cardType must be one of ${CARD_TYPES.join(', ')}.`)
    return undefined
  }
  return value
}

function checkNote(value: unknown, field: string, errors: string[]): string | undefined {
  return checkText(value, field, MAX_NOTE, errors)
}

/**
 * A request body.
 *
 * The kind discrimination is spelled out both ways -- a 'bin' body carrying
 * `cardName` is a 400, not a silently-dropped field -- because that mirrors the
 * exhaustive null-out CHECK in 0016. A body the validator quietly trimmed into
 * shape would be a body whose author misunderstood what they were sending.
 */
export function validateCardRequestInput(
  body: unknown,
  networks: NetworkForValidation[],
): Validated<CardRequestInput> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)

  if (!isRequestKind(body.kind)) {
    // Nothing below can be judged without knowing the kind.
    return { ok: false, errors: [...errors, "kind must be 'card' or 'bin'."] }
  }
  const kind = body.kind

  const network = checkNetwork(body.network, networks, errors)
  const bins = checkBins(body.bins, network, errors)
  const note = body.note === undefined ? undefined : checkNote(body.note, 'note', errors)

  let cardId: string | undefined
  let bankId: string | undefined
  let issuer: string | undefined
  let cardName: string | undefined
  let cardType: CardType | undefined

  if (kind === 'bin') {
    cardId = checkId(body.cardId, 'cardId', CARD_ID_PATTERN, errors)
    for (const field of ['bankId', 'issuer', 'cardName', 'cardType'] as const) {
      if (body[field] !== undefined) {
        errors.push(`${field} does not belong on a 'bin' request; it names an existing card.`)
      }
    }
  } else {
    if (body.cardId !== undefined) {
      errors.push("cardId does not belong on a 'card' request; the card does not exist yet.")
    }
    cardName = checkText(body.cardName, 'cardName', 120, errors)

    // Name the bank by id, or by name when there is no id to give. The form
    // picks from a list and sends the id; the free-text branch is for a caller
    // naming an issuer the catalog does not carry at all, which only an admin
    // can resolve. When both arrive the id wins and the display name is read
    // from the row, never from the client.
    if (body.bankId !== undefined) {
      bankId = checkId(body.bankId, 'bankId', BANK_ID_PATTERN, errors)
      if (body.issuer !== undefined) issuer = checkText(body.issuer, 'issuer', 80, errors)
    } else {
      issuer = checkText(body.issuer, 'issuer', 80, errors)
    }
    if (body.cardType !== undefined) {
      cardType = checkCardType(body.cardType, errors)
    }
  }

  if (errors.length > 0 || network === undefined || bins === undefined) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: { kind, cardId, bankId, issuer, cardName, cardType, network: network.code, bins, note },
  }
}

export function validateApprove(body: unknown): Validated<{ cardId?: string; note?: string }> {
  const errors: string[] = []
  // An empty body is the whole request on a 'bin' approval, so `{}` is valid.
  if (body !== undefined && !isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }
  const fields = isPlainObject(body) ? body : {}

  const cardId =
    fields.cardId === undefined
      ? undefined
      : checkId(fields.cardId, 'cardId', CARD_ID_PATTERN, errors)
  const note = fields.note === undefined ? undefined : checkNote(fields.note, 'note', errors)

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { cardId, note } }
}

/**
 * A rejection. The note is REQUIRED, and the CHECK in 0016 says so too:
 * "Rejected" with no reason is the worst version of this feature, and the only
 * person who can explain it is the one clicking the button.
 */
export function validateReject(body: unknown): Validated<{ note: string }> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  if (body.note === undefined) {
    return { ok: false, errors: [...errors, 'A rejection must say why.'] }
  }

  const note = checkNote(body.note, 'note', errors)
  if (note === undefined) return { ok: false, errors }

  return { ok: true, value: { note } }
}
