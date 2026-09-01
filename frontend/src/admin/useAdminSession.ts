import { useAuth } from '@clerk/react'
import { useEffect, useState } from 'react'
import { fetchMe } from '../data/api'

/**
 * Whether the person at the keyboard may use the console.
 *
 * Clerk answers "are you signed in"; only the server answers "are you an
 * admin", because that lives in `users.is_admin` and is deliberately not a
 * token claim -- a claim is something the client hands us, and this is not.
 *
 * Called once, by AdminApp, so a visitor who never opens `#/admin` never issues
 * the request.
 */
export type AdminSession =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'denied' }
  | { status: 'error'; message: string }
  | { status: 'admin' }

/** The answer to one `fetchMe`, tagged with the sign-in it was asked under. */
type Checked = { signedIn: boolean; isAdmin: boolean } | { signedIn: boolean; message: string }

export function useAdminSession(): AdminSession {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const [checked, setChecked] = useState<Checked | null>(null)

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return

    const controller = new AbortController()

    // The token comes straight from Clerk rather than from the getter api.ts
    // holds. That getter is registered by an effect in `App`, and React flushes
    // child effects first -- this component is a descendant, so on the commit
    // where the session appears the getter is still null and the request would
    // go out anonymous and 401. See the ordering note in data/api.ts.
    getToken()
      .then((token) => fetchMe(controller.signal, token))
      .then((me) => setChecked({ signedIn: true, isAdmin: me.isAdmin }))
      .catch((err: unknown) => {
        // Superseded by a newer check -- signing in re-runs this effect.
        if (err instanceof DOMException && err.name === 'AbortError') return
        setChecked({
          signedIn: true,
          message: err instanceof Error ? err.message : 'Could not check access.',
        })
      })

    return () => controller.abort()
  }, [isLoaded, isSignedIn, getToken])

  // Derived rather than written at the top of the effect, so signing out shows
  // the sign-in panel immediately instead of a stale verdict.
  if (!isLoaded) return { status: 'loading' }
  if (!isSignedIn) return { status: 'anonymous' }
  if (checked === null || !checked.signedIn) return { status: 'loading' }
  if ('message' in checked) return { status: 'error', message: checked.message }
  return checked.isAdmin ? { status: 'admin' } : { status: 'denied' }
}
