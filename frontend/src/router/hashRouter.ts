import { HANDLE_PATTERN } from '../data/handles'

export type Route =
  | { kind: 'landing' }
  | { kind: 'wallet' }
  | { kind: 'rating' }
  | { kind: 'login' }
  | { kind: 'verify' }
  | { kind: 'claim' }
  | { kind: 'profile'; username: string }
  | { kind: 'notFound'; hash: string }

export type RouteKind = Route['kind']

const STATIC_ROUTES = {
  '': 'landing',
  wallet: 'wallet',
  rating: 'rating',
  login: 'login',
  verify: 'verify',
  claim: 'claim',
} as const

export function parseHash(rawHash: string): Route {
  const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash

  // `#u/<username>` is matched before any leading slash is stripped, so the
  // shareable profile link stays a character shorter than the `#/...` screens.
  if (hash.startsWith('u/')) {
    const username = hash.slice(2)
    return HANDLE_PATTERN.test(username)
      ? { kind: 'profile', username }
      : { kind: 'notFound', hash }
  }

  const path = (hash.startsWith('/') ? hash.slice(1) : hash).replace(/\/$/, '')
  const kind = STATIC_ROUTES[path as keyof typeof STATIC_ROUTES]
  return kind ? { kind } : { kind: 'notFound', hash }
}

export function hrefFor(route: Route): string {
  switch (route.kind) {
    case 'landing':
      return '#/'
    case 'profile':
      return `#u/${route.username}`
    case 'notFound':
      return '#/'
    default:
      return `#/${route.kind}`
  }
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route)
}

/**
 * Sends a bare URL to `#/` before the first render. `replaceState` is used
 * rather than assigning `location.hash` so the landing screen does not leave a
 * second history entry behind the user's first Back press.
 */
export function normalizeInitialHash(): void {
  const { hash } = window.location
  if (hash === '' || hash === '#') {
    window.history.replaceState(null, '', '#/')
  }
}

export function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

// useSyncExternalStore compares snapshots by identity, so the parsed route is
// cached per hash string. Re-parsing on every read would return a fresh object
// each time and spin the render loop.
let cachedHash: string | null = null
let cachedRoute: Route = { kind: 'landing' }

export function getRouteSnapshot(): Route {
  const { hash } = window.location
  if (hash !== cachedHash) {
    cachedHash = hash
    cachedRoute = parseHash(hash)
  }
  return cachedRoute
}
