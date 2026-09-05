import { useAuth } from '@clerk/react'
import { useEffect, useRef } from 'react'
import { fetchWallet, mergeWallet } from '../data/api'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { walletActions } from '../store/walletSlice'
import { toWalletState } from './walletSync'

/**
 * Loads the account's wallet into this browser, once per session.
 *
 * Two ways in, and which one runs is the whole point. If this browser is
 * holding picks the server has not seen -- someone chose cards before signing
 * in -- they are merged, and the union means they join whatever the account
 * already held rather than replacing it. With nothing to hand off there is
 * nothing to merge, so the wallet is simply read.
 *
 * It used to merge every time, because the blob in localStorage kept a copy of
 * the wallet after the hand-off and `synced` does not survive a reload. That
 * re-sent the account its own cards on every page load, and since the union
 * only ever inserts, a card removed on another device came back. `picked` is
 * now empty once the server owns the wallet (see saveWalletState), which is
 * what makes the branch below mean what it says.
 *
 * Either way the answer is adopted wholesale, which is what makes the server
 * the source of truth from here on -- every later change writes through.
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

    // A merge is a write, so it is only worth making when there is genuinely
    // something to write. Reading is the common case by far: every load after
    // the first one for a given browser.
    const loaded = picked.length > 0 ? mergeWallet(picked) : fetchWallet()

    loaded
      .then((wallet) => {
        if (!cancelled) dispatch(walletActions.replaceFromServer(toWalletState(wallet)))
      })
      .catch((err) => {
        // The wallet stays local and unsynced. Leaving it that way is the
        // honest outcome: the write-through listeners check `synced`, so
        // nothing silently half-persists -- and because an un-merged blob is
        // still persisted, picks waiting to be handed off survive to retry on
        // the next load rather than being lost here.
        console.error('Could not load the wallet from the server', err)
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
