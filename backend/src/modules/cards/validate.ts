import { BANK_ID_PATTERN } from '../banks/bankTypes'
import {
  checkCountry,
  checkId,
  checkInteger,
  checkText,
  isPlainObject,
  rejectClientId,
} from '../../http/validators'
import type { CardInput, CardPatch } from './cardTypes'

/** Matches the CHECK constraint in migration 0002. */
export const MAX_FEE = 10_000_000

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/** Fees are optional on write; an omitted fee means a free card. */
function checkFee(value: unknown, field: string, errors: string[]): number | undefined {
  return value === undefined ? 0 : checkInteger(value, field, 0, MAX_FEE, errors)
}

export function validateCardInput(body: unknown): Validated<CardInput> {
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
    },
  }
}

export function validateCardPatch(body: unknown): Validated<CardPatch> {
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

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push('Provide at least one field to update.')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: patch }
}
