import { useAuth } from '@clerk/react'
import { useEffect } from 'react'
import { setAuthTokenGetter } from '../data/api'

/**
 * Hands the API client a way to reach Clerk's session token.
 *
 * `getToken` is only available through a hook, and api.ts is plain functions,
 * so the getter is registered once at the root rather than threaded through
 * every call. Clerk keeps `getToken` stable and handles refreshing behind it,
 * so this re-runs only when the identity itself changes.
 */
export function useApiAuth(): void {
  const { getToken, isSignedIn } = useAuth()

  useEffect(() => {
    // Unregistered while signed out, so nothing sends a stale token after the
    // session ends -- the catalog is public and wants the anonymous response.
    if (!isSignedIn) {
      setAuthTokenGetter(null)
      return
    }

    setAuthTokenGetter(() => getToken())
    return () => setAuthTokenGetter(null)
  }, [getToken, isSignedIn])
}
