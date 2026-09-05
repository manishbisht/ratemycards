import { useAuth } from '@clerk/react'
import { useEffect, useState } from 'react'
import { useAppSelector } from '../store/hooks'
import { selectCatalogStatus, selectVerifiedCards, selectWallet } from '../store/selectors'
import { getInitialRoute, redirect } from './hashRouter'
import type { Route } from './hashRouter'

/**
 * How long to hold the landing screen back before showing the pitch anyway.
 *
 * A failed wallet merge and a failed `/v1/users/me` both fail silently -- each
 * only leaves its flag unset -- so there is no error state to read for either.
 * This is the backstop that covers them, and a hung Clerk load besides. Past it
 * the visitor drives, which is exactly the behaviour they had before any of
 * this existed.
 */
const GIVE_UP_MS = 2500

/**
 * Spent once a redirect has fired -- or been given up on -- for this page load.
 *
 * Module-level rather than component state because it has to outlive
 * LandingPage unmounting: without it the picker's back arrow and the profile's
 * "Rate your own wallet" would bounce a signed-in visitor straight back out,
 * and the landing screen would be unreachable for the rest of the session.
 */
let spent = false

/**
 * Where a signed-in visitor belongs, given what they have.
 *
 * Split out and pure because it is the whole rule, and the rest of this file is
 * the machinery for knowing when its inputs can be trusted.
 */
function destinationFor(verifiedCount: number, handle: string | null): Route {
  // Nothing verified: the wallet is where a rating comes from.
  if (verifiedCount === 0) return { kind: 'wallet' }

  // Verified something but never finished -- send them to the step they
  // abandoned rather than to a profile that does not exist.
  if (handle === null) return { kind: 'claim' }

  return { kind: 'profile', username: handle }
}

/**
 * 'waiting' while it may still redirect away from the landing screen, 'stay'
 * once the landing screen is the answer.
 *
 * The pitch is for people who have not built a wallet. A signed-in visitor
 * arriving at `#/` gets sent to their own screen instead, which means holding
 * the render until four separate things have settled -- Clerk, the wallet
 * merge, the catalog, and the handle. 'waiting' is what stops "Build your
 * wallet" painting for a beat and then being yanked away.
 */
export function useLandingDestination(): 'waiting' | 'stay' {
  const { isLoaded, isSignedIn } = useAuth()
  const { user, synced, handle, handleSynced } = useAppSelector(selectWallet)
  const verifiedCount = useAppSelector(selectVerifiedCards).length
  const catalogStatus = useAppSelector(selectCatalogStatus)

  // Read once at mount, so rendering stays a pure function of state and store
  // even though the flag behind it is mutable. The effects below are its only
  // writers.
  const [alreadySpent] = useState(() => spent)
  const [gaveUp, setGaveUp] = useState(false)

  // Only an arrival counts. Walking back to `#/` from inside the app -- the
  // picker's back arrow, "Rate your own wallet" on someone else's profile --
  // has to show the pitch, not redirect: the visitor asked for this screen.
  const arrived = getInitialRoute()?.kind === 'landing'

  // The catalog is in here because `selectVerifiedCards` resolves ids through
  // it, so before it is ready every wallet looks empty -- and a wrong answer
  // here sends someone with a full wallet to the picker.
  const settled = synced && handleSynced && catalogStatus === 'ready'
  const hopeless = gaveUp || catalogStatus === 'error'

  // While Clerk is still loading, `isSignedIn` reads false -- and neither
  // answer to "assume signed out?" is free. Assume yes and a returning visitor
  // gets the pitch for a frame before being yanked off it; assume no and every
  // anonymous visitor stares at an empty screen for as long as Clerk takes,
  // which is the one audience the pitch is actually for.
  //
  // So guess from the wallet's own persisted user instead, which is already in
  // the store from localStorage before the first paint. It is wrong only for
  // someone whose session started in another tab, and Clerk overrules it the
  // moment it loads either way.
  const signedIn = isLoaded ? isSignedIn : user !== null
  const hold = arrived && !alreadySpent && !hopeless && signedIn

  useEffect(() => {
    if (!hold || !settled || spent) return

    spent = true
    redirect(destinationFor(verifiedCount, handle))
  }, [hold, settled, verifiedCount, handle])

  useEffect(() => {
    if (!hold) return

    const timer = setTimeout(() => {
      // Spent, not merely given up on: a remount must not start the wait over
      // and blank the screen again on a connection that has already failed us.
      spent = true
      setGaveUp(true)
    }, GIVE_UP_MS)

    return () => clearTimeout(timer)
  }, [hold])

  return hold ? 'waiting' : 'stay'
}
