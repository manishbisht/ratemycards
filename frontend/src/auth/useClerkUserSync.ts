import { useUser } from '@clerk/react'
import { useEffect } from 'react'
import { fetchMe } from '../data/api'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { walletActions } from '../store/walletSlice'

/**
 * Mirrors the Clerk session into the wallet slice.
 *
 * The flow gates (`state.user !== null` in the picker, reveal and claim pages)
 * predate Clerk and read from Redux. Rather than teaching every one of them to
 * call `useAuth`, this runs once at the root and keeps the slice in step with
 * Clerk, which stays the source of truth.
 */
export function useClerkUserSync(): void {
  const dispatch = useAppDispatch()
  const { isLoaded, isSignedIn, user } = useUser()
  const hasStoredUser = useAppSelector((state) => state.wallet.user !== null)

  const name = user?.fullName ?? user?.username ?? null
  const email = user?.primaryEmailAddress?.emailAddress ?? null

  useEffect(() => {
    if (!isLoaded) return

    if (!isSignedIn) {
      // Only when there is a session to end. signOut now empties the wallet,
      // and this branch is also every anonymous page load -- firing it
      // unconditionally would delete the picks of someone who never signed in.
      if (hasStoredUser) dispatch(walletActions.signOut())
      return
    }

    dispatch(walletActions.signIn({ name: name ?? email ?? 'You', email: email ?? '' }))
  }, [dispatch, isLoaded, isSignedIn, hasStoredUser, name, email])

  // The handle lives on the server, not in this browser. Without this, signing
  // in on a second device looks like you never claimed one -- Redux is
  // populated from localStorage, which is per-browser by definition.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return

    const controller = new AbortController()

    fetchMe(controller.signal)
      .then((profile) => {
        if (profile.handle) dispatch(walletActions.claimHandle(profile.handle))
      })
      .catch(() => {
        // Not fatal. The claim screen re-checks against the server anyway, and
        // a failure here only means the handle is not shown until next load.
      })

    return () => controller.abort()
  }, [dispatch, isLoaded, isSignedIn])
}
