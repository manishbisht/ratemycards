import type { BankInput, BankPatch } from './bankTypes'
import { checkText, isPlainObject, rejectClientId } from '../../http/validators'

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export function validateBankInput(body: unknown): Validated<BankInput> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)
  const name = checkText(body.name, 'name', 80, errors)

  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    errors.push('isActive must be a boolean.')
  }

  if (errors.length > 0 || name === undefined) return { ok: false, errors }
  return { ok: true, value: { name, isActive: body.isActive as boolean | undefined } }
}

export function validateBankPatch(body: unknown): Validated<BankPatch> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)

  const patch: BankPatch = {}
  if (body.name !== undefined) patch.name = checkText(body.name, 'name', 80, errors)
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') errors.push('isActive must be a boolean.')
    else patch.isActive = body.isActive
  }

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push('Provide at least one field to update.')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: patch }
}
