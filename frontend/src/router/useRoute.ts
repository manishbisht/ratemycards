import { useSyncExternalStore } from 'react'
import { getRouteSnapshot, subscribeToHash } from './hashRouter'
import type { Route } from './hashRouter'

export function useRoute(): Route {
  return useSyncExternalStore(subscribeToHash, getRouteSnapshot)
}
