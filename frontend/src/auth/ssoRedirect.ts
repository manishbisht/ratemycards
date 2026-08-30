/**
 * Where Google sends the browser back to, and how the app recognises it.
 *
 * Two constraints shape this. GitHub Pages has no SPA fallback, so the only
 * path it will serve is the site root — a dedicated `/sso-callback` route would
 * 404 in production. And the app routes on the hash, so a marker in the hash
 * would collide with routing and with any query params Clerk appends. A search
 * param on the root satisfies both: static hosting ignores it, and it sits
 * before the hash where `location.search` can read it.
 */
const PARAM = 'clerk_sso'

type SsoStage = 'callback' | 'complete'

function urlForStage(stage: SsoStage): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set(PARAM, stage)
  return url.toString()
}

/** Where Clerk continues a sign-in that needs more than the Google account. */
export const ssoCallbackUrl = (): string => urlForStage('callback')

/** Where Clerk lands the browser once the session exists. */
export const ssoCompleteUrl = (): string => urlForStage('complete')

export function isSsoCallback(): boolean {
  return new URLSearchParams(window.location.search).get(PARAM) === 'callback'
}

/**
 * Runs before the first render, beside `normalizeInitialHash`. A finished round
 * trip lands on the bare root, so it is rewritten to the step the user was on
 * their way to and the marker is dropped — otherwise a refresh or a Back press
 * would replay the return.
 */
export function normalizeSsoReturn(): void {
  if (new URLSearchParams(window.location.search).get(PARAM) !== 'complete') return

  const url = new URL(window.location.href)
  url.searchParams.delete(PARAM)
  window.history.replaceState(null, '', `${url.pathname}${url.search}#/verify`)
}
