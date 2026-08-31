import { checkText, isPlainObject, rejectClientId } from '../../http/validators'
import { BIN_RULE_KINDS, isBinRuleKind, isBinRuleValue } from './binRules'
import type { BinRule } from './binRules'
import type { NetworkInput, NetworkPatch } from './networkTypes'

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/** Matches the CHECK on networks.code in migration 0009. */
const CODE_PATTERN = /^[a-z0-9]{2,20}$/

function checkCode(value: unknown, errors: string[]): string | undefined {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!CODE_PATTERN.test(raw)) {
    errors.push('code must be 2 to 20 lowercase letters or digits, e.g. "visa".')
    return undefined
  }
  return raw
}

/**
 * The prefix rules a network allocates under. Overlaps the CHECK constraints on
 * network_bin_rules on purpose: this exists to produce a good 400, the
 * constraints are the backstop.
 *
 * `allowEmpty` is the POST/PATCH difference. Creating a network with no rules
 * would create one no BIN can ever be added under; clearing them on an existing
 * network is a deliberate way to take it out of service for new BINs.
 */
function checkBinRules(
  value: unknown,
  allowEmpty: boolean,
  errors: string[],
): BinRule[] | undefined {
  if (!Array.isArray(value)) {
    errors.push('binRules must be an array.')
    return undefined
  }
  if (value.length === 0 && !allowEmpty) {
    errors.push('binRules must contain at least one rule.')
    return undefined
  }

  const rules: BinRule[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      errors.push('Each bin rule must be an object with a kind and a value.')
      continue
    }
    if (!isBinRuleKind(entry.kind)) {
      errors.push(`Rule kind must be one of ${BIN_RULE_KINDS.join(', ')}.`)
      continue
    }
    if (typeof entry.value !== 'string') {
      errors.push('Rule value must be a string.')
      continue
    }
    if (!isBinRuleValue(entry.kind, entry.value)) {
      errors.push(
        entry.kind === 'glob'
          ? `Glob '${entry.value}' must be digits, '*', and character classes like [1-5] -- e.g. '4*' or '5[1-5]*'.`
          : `Range '${entry.value}' must be two four-digit bounds, low first, e.g. "2221-2720".`,
      )
      continue
    }
    if (rules.some((r) => r.kind === entry.kind && r.value === entry.value)) continue
    rules.push({ kind: entry.kind, value: entry.value })
  }

  return errors.length > 0 ? undefined : rules
}

export function validateNetworkInput(body: unknown): Validated<NetworkInput> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)
  const code = checkCode(body.code, errors)
  const name = checkText(body.name, 'name', 40, errors)
  const binRules = checkBinRules(body.binRules, false, errors)

  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    errors.push('isActive must be a boolean.')
  }

  if (errors.length > 0 || code === undefined || name === undefined || binRules === undefined) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: { code, name, binRules, isActive: body.isActive as boolean | undefined },
  }
}

export function validateNetworkPatch(body: unknown): Validated<NetworkPatch> {
  const errors: string[] = []
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['The request body must be a JSON object.'] }
  }

  rejectClientId(body, errors)

  const patch: NetworkPatch = {}
  if (body.code !== undefined) patch.code = checkCode(body.code, errors)
  if (body.name !== undefined) patch.name = checkText(body.name, 'name', 40, errors)
  if (body.binRules !== undefined) patch.binRules = checkBinRules(body.binRules, true, errors)
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') errors.push('isActive must be a boolean.')
    else patch.isActive = body.isActive
  }

  if (Object.keys(patch).length === 0 && errors.length === 0) {
    errors.push('Provide at least one field to update.')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: patch }
}
