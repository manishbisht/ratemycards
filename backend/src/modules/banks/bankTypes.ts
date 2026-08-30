import { generateId, idPattern } from '../../http/ids'

export const BANK_ID_PREFIX = 'bank'
export const BANK_ID_PATTERN = idPattern(BANK_ID_PREFIX)

export function generateBankId(): string {
  return generateId(BANK_ID_PREFIX)
}

export type Bank = {
  id: string
  name: string
  isActive: boolean
}

export type BankInput = {
  name: string
  isActive?: boolean
}

export type BankPatch = Partial<BankInput>

export type BankFilters = {
  q?: string
  includeInactive: boolean
  limit: number
  offset: number
}
