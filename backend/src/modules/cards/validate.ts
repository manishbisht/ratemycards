import { BANK_ID_PATTERN } from '../banks/bankTypes'
import {
  checkCountry,
  checkId,
  checkInteger,
  checkText,
  isPlainObject,
  rejectClientId,
} from '../../http/validators'
import { matchesBinRules } from '../networks/binRules'
import type { NetworkForValidation } from '../networks/queries'
import type { CardInput, CardNetworkInput, CardPatch } from './cardTypes'

/** Matches the CHECK constraint in migration 0002. */
export const MAX_FEE = 10_000_000

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/** Fees are optional on write; an omitted fee means a free card. */
function checkFee(value: unknown, field: string, errors: string[]): number | undefined {
  return value === undefined ? 0 : checkInteger(value, field, 0, MAX_FEE, errors)
}

/** Matches the CHECK on card_bins.bin_prefix in migration 0009. */
const BIN_PATTERN = /^(\d{6}|\d{8})$/

/**
 * The BIN prefixes to record under one network of a card.
 *
 * `seen` spans the whole request: within a single card a prefix belongs to
 * exactly one network, which the primary key on card_bins also enforces. The
 * check is here so the caller gets a sentence rather than a constraint failure.
 */
function checkBins(
  value: unknown,
  network: NetworkForValidation,
  seen: Map<string, string>,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push(`bins for '${network.code}' must be an array.`)
    return undefined
  }
  if (value.length > 0 && network.binRules.length === 0) {
    errors.push(`Network '${network.code}' has no BIN rules on file; add them first.`)
    return undefined
  }

  const bins: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string' || !BIN_PATTERN.test(raw)) {
      errors.push(`BIN '${String(raw)}' must be 6 or 8 digits.`)
      continue
    }
    const owner = seen.get(raw)
    if (owner !== undefined && owner !== network.code) {
      errors.push(`BIN '${raw}' is listed under more than one network.`)
      continue
    }
    if (!matchesBinRules(raw, network.binRules)) {
      errors.push(`BIN '${raw}' is not valid for network '${network.code}'.`)
      continue
    }
    seen.set(raw, network.code)
    if (!bins.includes(raw)) bins.push(raw)
  }

  return bins
}

/**
 * The networks a card is issued on, with the prefixes under each.
 *
 * `known` carries inactive networks too, so an unknown code and a retired one
 * get different messages -- they are different mistakes.
 *
 * An empty array is accepted and means "on no networks", which clears both
 * tables. That relaxes the previous rule: an admin editing a card they got
 * wrong needs a way back to empty, and a card with no networks is a real if
 * unselectable state.
 */
function checkNetworks(
  value: unknown,
  known: NetworkForValidation[],
  errors: string[],
): CardNetworkInput[] | undefined {
  if (!Array.isArray(value)) {
    errors.push('networks must be an array.')
    return undefined
  }

  const out: CardNetworkInput[] = []
  const seenCodes = new Set<string>()
  const seenBins = new Map<string, string>()

  for (const entry of value) {
    if (!isPlainObject(entry)) {
      errors.push('Each network must be an object with a code and bins.')
      continue
    }

    const code = typeof entry.code === 'string' ? entry.code.trim().toLowerCase() : ''
    const network = known.find((n) => n.code === code)
    if (!network) {
      errors.push(`'${code}' is not a known network.`)
      continue
    }
    if (!network.isActive) {
      errors.push(`Network '${code}' is not active.`)
      continue
    }
    if (seenCodes.has(code)) {
      errors.push(`Network '${code}' is listed twice.`)
      continue
    }
    seenCodes.add(code)

    const bins = checkBins(entry.bins, network, seenBins, errors)
    if (bins === undefined) continue
    out.push({ code, bins })
  }

  return errors.length > 0 ? undefined : out
}

export function validateCardInput(
  body: unknown,
  networks: NetworkForValidation[],
): Validated<CardInput> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)
  const bankId = checkId(body.bankId, 'bankId', BANK_ID_PATTERN, errors)
  const name = checkText(body.name, 'name', 120, errors)
  const country = checkCountry(body.country, errors)
  const joiningFee = checkFee(body.joiningFee, 'joiningFee', errors)
  const annualFee = checkFee(body.annualFee, 'annualFee', errors)

  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    errors.push('isActive must be a boolean.')
  }

  const cardNetworks =
    body.networks === undefined ? undefined : checkNetworks(body.networks, networks, errors)

  if (
    errors.length > 0 ||
    bankId === undefined ||
    name === undefined ||
    country === undefined ||
    joiningFee === undefined ||
    annualFee === undefined
  ) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      bankId,
      name,
      country,
      joiningFee,
      annualFee,
      isActive: body.isActive as boolean | undefined,
      networks: cardNetworks,
    },
  }
}

export function validateCardPatch(
  body: unknown,
  networks: NetworkForValidation[],
): Validated<CardPatch> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)

  const patch: CardPatch = {}
  if (body.bankId !== undefined) {
    patch.bankId = checkId(body.bankId, 'bankId', BANK_ID_PATTERN, errors)
  }
  if (body.name !== undefined) patch.name = checkText(body.name, 'name', 120, errors)
  if (body.country !== undefined) patch.country = checkCountry(body.country, errors)
  if (body.joiningFee !== undefined) {
    patch.joiningFee = checkInteger(body.joiningFee, 'joiningFee', 0, MAX_FEE, errors)
  }
  if (body.annualFee !== undefined) {
    patch.annualFee = checkInteger(body.annualFee, 'annualFee', 0, MAX_FEE, errors)
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') errors.push('isActive must be a boolean.')
    else patch.isActive = body.isActive
  }
  if (body.networks !== undefined) {
    patch.networks = checkNetworks(body.networks, networks, errors)
  }

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push('Provide at least one field to update.')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: patch }
}
