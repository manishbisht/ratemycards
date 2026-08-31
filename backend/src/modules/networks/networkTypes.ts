import { generateId, idPattern } from '../../http/ids'

export const NETWORK_ID_PREFIX = 'network'
export const NETWORK_ID_PATTERN = idPattern(NETWORK_ID_PREFIX)

export function generateNetworkId(): string {
  return generateId(NETWORK_ID_PREFIX)
}
