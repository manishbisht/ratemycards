/**
 * Microsoft Clarity, loaded only when `VITE_CLARITY_PROJECT_ID` is set. Local
 * dev leaves it unset, so nothing is injected and no session is recorded --
 * the dashboard stays a record of real visitors rather than of us.
 */

import { useEffect } from 'react'
import type { Route } from '../router/hashRouter'

/**
 * Clarity's tag replays whatever the page queued on `window.clarity` before
 * the script finished loading, so the stub below must keep the shape the
 * official snippet installs: a callable that pushes each call's arguments onto
 * `q`. The snippet queues `arguments` objects; the replay applies them, so a
 * plain array -- which lint prefers -- is equivalent here.
 */
type ClarityFn = {
  (...args: unknown[]): void
  q?: unknown[][]
}

declare global {
  interface Window {
    clarity?: ClarityFn
  }
}

const TAG_URL = 'https://www.clarity.ms/tag/'

/**
 * Labels come from the parsed route rather than `location.hash`: every profile
 * view belongs in one bucket, and a username in the label would both fragment
 * the dashboard and hand a third party a list of our handles.
 */
function pageLabel(route: Route): string {
  return route.kind === 'profile' ? 'u/:username' : route.kind
}

/** Injects the tag. Call once, before the first render. */
export function initClarity(): void {
  const projectId: string | undefined = import.meta.env.VITE_CLARITY_PROJECT_ID
  // A second tag would open a second session, so an existing queue means this
  // has already run and there is nothing left to do.
  if (!projectId || window.clarity) return

  const clarity: ClarityFn = (...args) => {
    ;(clarity.q = clarity.q ?? []).push(args)
  }
  window.clarity = clarity

  const script = document.createElement('script')
  script.async = true
  script.src = `${TAG_URL}${encodeURIComponent(projectId)}`
  document.head.appendChild(script)
}

/**
 * Tags each screen. The hash router never reloads the document, so without
 * this every session would report a single page view.
 */
export function useClarityPage(route: Route): void {
  useEffect(() => {
    // Absent whenever no project id was configured -- the whole integration
    // no-ops through this optional call.
    window.clarity?.('set', 'page', pageLabel(route))
  }, [route])
}
