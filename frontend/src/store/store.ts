import { configureStore, createListenerMiddleware } from '@reduxjs/toolkit'
import { addWalletCard, removeWalletCard, setWalletCardStatus } from '../data/api'
import { catalogReducer, loadCatalog } from './catalogSlice'
import { saveWalletState, loadWalletState } from './walletPersistence'
import { scoreReducer } from './scoreSlice'
import { walletActions, walletReducer } from './walletSlice'

const listenerMiddleware = createListenerMiddleware()

/*
 * There used to be a listener here that answered `startVerification` with a
 * 2.2-second setTimeout and then marked the card 'verified'. It was the design
 * mock standing in for a verification that did not exist yet.
 *
 * It is gone because verification is real now: VerifyCardsPage opens Razorpay
 * Checkout and the server decides, in POST /v1/verifications/:id/confirm. While
 * both existed the mock won every race -- it fired 2.2s after the modal opened,
 * long before anyone finished paying -- so every card came out verified whatever
 * Razorpay said. `startVerification` now only paints the row 'pending'.
 */

/**
 * Write-through to the server, for signed-in visitors only.
 *
 * The reducers stay synchronous and optimistic -- the picker must not wait on a
 * round trip -- so these listeners follow the local change with the API call.
 * `synced` is the gate: until the sign-in merge has run, the server does not
 * yet have this wallet and telling it about one card at a time would be wrong.
 *
 * A failure is logged rather than rolled back. Reverting a card someone just
 * tapped is its own kind of wrong; what must not happen is silently believing a
 * write landed.
 *
 * Drift from a failed write used to heal itself, because the next load merged
 * this browser's copy back up. It no longer does: that copy is exactly what
 * resurrected cards deleted on other devices, so a load now reads the wallet
 * instead, and the server's view wins. The two are the same mechanism seen from
 * opposite sides -- local state cannot re-assert itself without also being able
 * to undo someone's removal.
 */
function isServerBacked(state: RootState): boolean {
  return state.wallet.user !== null && state.wallet.synced
}

listenerMiddleware.startListening({
  actionCreator: walletActions.toggleCard,
  effect: async (action, listenerApi) => {
    const state = listenerApi.getState() as RootState
    if (!isServerBacked(state)) return

    const id = action.payload
    // The reducer has already run, so the local state says which way it went.
    const added = state.wallet.picked.includes(id)

    try {
      if (!added) {
        await removeWalletCard(id)
        return
      }

      // A card that was proved before it was removed comes back proved: the
      // payment that earned it is on file server-side and outlived the wallet
      // row. The response says so, and adopting it is what keeps this screen
      // from offering to verify something the server will refuse to verify
      // twice -- the local state has no memory of a verification it dropped.
      const wallet = await addWalletCard(id)
      const entry = wallet.cards.find((walletCard) => walletCard.card.id === id)
      if (entry) {
        listenerApi.dispatch(
          walletActions.adoptCardStatus({
            id,
            status: entry.verificationStatus,
            at: entry.verifiedAt,
          }),
        )
      }
    } catch (err) {
      console.error(`Could not ${added ? 'add' : 'remove'} card '${id}' on the server`, err)
    }
  },
})

listenerMiddleware.startListening({
  actionCreator: walletActions.setVerificationStatus,
  effect: async (action, listenerApi) => {
    const state = listenerApi.getState() as RootState
    if (!isServerBacked(state)) return

    const { id, status } = action.payload
    // The reducer has already declined to record this if the card is no longer
    // held, so writing it through would tell the server something this browser
    // does not itself believe -- and PATCH answers 404 for a card that is not in
    // the wallet. That is the shape a removal takes when it races a
    // verification: the card goes, then the attempt it left behind reports how
    // it went. Nothing to record, nothing to send.
    if (!state.wallet.picked.includes(id)) return

    try {
      await setWalletCardStatus(id, status)
    } catch (err) {
      console.error(`Could not record verification for card '${id}' on the server`, err)
    }
  },
})

listenerMiddleware.startListening({
  actionCreator: loadCatalog.fulfilled,
  effect: (action, listenerApi) => {
    if (action.payload.cards.length >= action.payload.total) {
      listenerApi.dispatch(walletActions.pruneCards(action.payload.cards.map((card) => card.id)))
    }
  },
})

export const store = configureStore({
  reducer: {
    wallet: walletReducer,
    catalog: catalogReducer,
    score: scoreReducer,
  },
  preloadedState: { wallet: loadWalletState() },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().prepend(listenerMiddleware.middleware),
})

store.subscribe(() => saveWalletState(store.getState().wallet))

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
