import { generateId, idPattern } from '../../http/ids'
import type { BinRule } from './binRules'

export const NETWORK_ID_PREFIX = 'network'
export const NETWORK_ID_PATTERN = idPattern(NETWORK_ID_PREFIX)

export function generateNetworkId(): string {
  return generateId(NETWORK_ID_PREFIX)
}

/**
 * A payment network. `binRules` travels with it everywhere: a network without
 * its prefix rules cannot validate a BIN, so nothing wants one without the
 * other.
 */
export type Network = {
  id: string
  code: string
  name: string
  isActive: boolean
  binRules: BinRule[]
}

export type NetworkInput = {
  code: string
  name: string
  binRules: BinRule[]
  isActive?: boolean
}

export type NetworkPatch = Partial<NetworkInput>

export type NetworkFilters = {
  q?: string
  includeInactive: boolean
  limit: number
  offset: number
}
