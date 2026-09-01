/**
 * Where this build is actually being served from, and how a public profile
 * link is built out of it.
 *
 * Derived from the URL rather than configured. A constant -- in code or in a
 * VITE_* variable -- is a second place that has to agree with reality, and the
 * failure is silent: move the domain, forget to update it, and every screen
 * advertises a host the app is not on. Reading `location` cannot drift.
 *
 * It also means the URL the claim screen shows is, by construction, the one the
 * share buttons copy. In development both say `localhost:5173`, which is
 * correct rather than unfortunate.
 *
 * Evaluated once at import: an SPA never changes origin without a full reload.
 */

/** Host, with the port in dev. `ratemycards.manishbisht.me` in production. */
export const PUBLIC_DOMAIN = window.location.host

/**
 * The scheme-less prefix a handle is appended to, for display next to an input.
 * `ratemycards.manishbisht.me/#/u/`
 */
export const PROFILE_PREFIX = `${window.location.host}${window.location.pathname}#/u/`

/**
 * The real, shareable profile URL, scheme included.
 *
 * `pathname` is carried so this keeps working if the app is ever served from a
 * sub-path rather than the root of its own domain.
 */
export function profileUrl(handle: string): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#/u/${handle}`
}
