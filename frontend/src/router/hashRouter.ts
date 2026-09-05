import { HANDLE_PATTERN } from '../data/handles'

export type Route =
  | { kind: 'landing' }
  | { kind: 'wallet' }
  | { kind: 'rating' }
  | { kind: 'login' }
  | { kind: 'verify' }
  | { kind: 'claim' }
  | { kind: 'profile'; username: string }
  | { kind: 'adminBanks' }
  | { kind: 'adminBank'; bankId: string }
  | { kind: 'adminCard'; cardId: string }
  | { kind: 'adminNetworks' }
  | { kind: 'adminCriteria' }
  | { kind: 'notFound'; hash: string }

export type RouteKind = Route['kind']

/**
 * The desktop console's screens. Everything else in the app is a phone screen,
 * and the two are gated in opposite directions -- see AdminGate.
 */
export type AdminRoute = Extract<
  Route,
  { kind: 'adminBanks' | 'adminBank' | 'adminCard' | 'adminNetworks' | 'adminCriteria' }
>

const ADMIN_KINDS: ReadonlySet<RouteKind> = new Set<RouteKind>([
  'adminBanks',
  'adminBank',
  'adminCard',
  'adminNetworks',
  'adminCriteria',
])

export function isAdminRoute(route: Route): route is AdminRoute {
  return ADMIN_KINDS.has(route.kind)
}

const STATIC_ROUTES = {
  '': 'landing',
  wallet: 'wallet',
  rating: 'rating',
  login: 'login',
  verify: 'verify',
  claim: 'claim',
  // Bare `#/admin` is the bank list; there is no separate index screen.
  admin: 'adminBanks',
  'admin/banks': 'adminBanks',
  'admin/networks': 'adminNetworks',
  'admin/criteria': 'adminCriteria',
} as const

/**
 * Server-minted ids, mirroring `idPattern` in the API's http/ids.ts. Matched
 * rather than passed through so a typo lands on notFound instead of a 404 from
 * the API after a render.
 */
const BANK_ID_PATTERN = /^bank_[0-9a-f]{32}$/
const CARD_ID_PATTERN = /^card_[0-9a-f]{32}$/

export function parseHash(rawHash: string): Route {
  const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash

  // `#/u/<handle>` is the only spelling. An earlier draft also took the
  // slash-less `#u/<handle>` to save a character in a shared link; that made
  // profiles the one route not shaped like every other, and it is gone --
  // `#u/...` now falls through to notFound like any other unknown hash.
  //
  // Matched here, before the leading slash is stripped below, because after
  // that this would be indistinguishable from a static route named `u`.
  if (hash.startsWith('/u/')) {
    const username = hash.slice(3)
    return HANDLE_PATTERN.test(username)
      ? { kind: 'profile', username }
      : { kind: 'notFound', hash }
  }

  const path = (hash.startsWith('/') ? hash.slice(1) : hash).replace(/\/$/, '')

  // The two admin screens that carry an id. Checked before the static lookup
  // because `admin/banks` is both a screen of its own and this prefix.
  const bankId = path.startsWith('admin/banks/') ? path.slice('admin/banks/'.length) : null
  if (bankId !== null) {
    return BANK_ID_PATTERN.test(bankId) ? { kind: 'adminBank', bankId } : { kind: 'notFound', hash }
  }

  const cardId = path.startsWith('admin/cards/') ? path.slice('admin/cards/'.length) : null
  if (cardId !== null) {
    return CARD_ID_PATTERN.test(cardId) ? { kind: 'adminCard', cardId } : { kind: 'notFound', hash }
  }

  const kind = STATIC_ROUTES[path as keyof typeof STATIC_ROUTES]
  return kind ? { kind } : { kind: 'notFound', hash }
}

/**
 * Every kind is listed. There is deliberately no `default` branch: the declared
 * `string` return turns the switch into an exhaustiveness check, so adding a
 * route without a link for it is a compile error rather than a dead `#/...`
 * that `parseHash` will not match.
 */
export function hrefFor(route: Route): string {
  switch (route.kind) {
    case 'landing':
      return '#/'
    case 'wallet':
    case 'rating':
    case 'login':
    case 'verify':
    case 'claim':
      return `#/${route.kind}`
    case 'profile':
      return `#/u/${route.username}`
    case 'adminBanks':
      return '#/admin/banks'
    case 'adminBank':
      return `#/admin/banks/${route.bankId}`
    case 'adminCard':
      return `#/admin/cards/${route.cardId}`
    case 'adminNetworks':
      return '#/admin/networks'
    case 'adminCriteria':
      return '#/admin/criteria'
    case 'notFound':
      return '#/'
  }
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route)
}

/**
 * Like `navigate`, but without leaving a history entry behind.
 *
 * For sending someone somewhere they did not ask to go -- see
 * useLandingDestination, which lands a returning user on their own screen
 * instead of the pitch. Pushing there would put the screen they were skipping
 * one Back press away, and Back would land them on a screen that was only ever
 * going to redirect them again.
 *
 * `replaceState` updates `location.hash` but fires no `hashchange`, and
 * `useRoute` is a `useSyncExternalStore` over exactly that event -- so the
 * event is raised by hand. The listener re-reads `location.hash`, which is
 * already the new one by then.
 */
export function redirect(route: Route): void {
  window.history.replaceState(null, '', hrefFor(route))
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/**
 * The route this page load began on -- `null` until `normalizeInitialHash` has
 * run, which is deliberately the only writer: by then `normalizeSsoReturn` has
 * had its say (a finished Google trip arrives on the bare root and is rewritten
 * to `#/verify`), and nothing in the app has navigated yet.
 *
 * Read by useLandingDestination to tell an actual arrival at a screen from a
 * later walk back to it. Staying `null` when nobody normalizes just means no
 * arrival is claimed, which is the safe answer.
 */
let initialRoute: Route | null = null

export function getInitialRoute(): Route | null {
  return initialRoute
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

  initialRoute = parseHash(window.location.hash)
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
