import { useAuth } from '@clerk/react'
import { useEffect, useRef } from 'react'
import { mergeWallet } from '../data/api'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { walletActions } from '../store/walletSlice'
import { toWalletState } from './walletSync'

/**
 * Reconciles this browser's wallet with the account's, once per session.
 *
 * The merge is a union on the server, so the cards someone picked before
 * signing in join whatever the account already held rather than replacing it.
 * What comes back is adopted wholesale, which is also what makes the server the
 * source of truth from here on -- every later change writes through.
 */
export function useWalletServerSync(): void {
  const dispatch = useAppDispatch()
  const { isLoaded, isSignedIn } = useAuth()
  const picked = useAppSelector((state) => state.wallet.picked)
  const synced = useAppSelector((state) => state.wallet.synced)

  // A failed merge must not re-run on the next render: the effect's own
  // dependencies would still say "signed in and unsynced", which is a loop.
  const attempted = useRef(false)

  useEffect(() => {
    if (!isLoaded || !isSignedIn || synced || attempted.current) return

    attempted.current = true
    let cancelled = false

    mergeWallet(picked)
      .then((wallet) => {
        if (!cancelled) dispatch(walletActions.replaceFromServer(toWalletState(wallet)))
      })
      .catch((err) => {
        // The wallet stays local and unsynced. Leaving it that way is the
        // honest outcome: the write-through listeners check `synced`, so
        // nothing silently half-persists.
        console.error('Could not sync the wallet with the server', err)
      })

    return () => {
      cancelled = true
    }
  }, [dispatch, isLoaded, isSignedIn, synced, picked])

  // A new session starts unsynced, so the guard has to reopen with it.
  useEffect(() => {
    if (!isSignedIn) attempted.current = false
  }, [isSignedIn])
}
