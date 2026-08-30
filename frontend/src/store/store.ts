import { configureStore, createListenerMiddleware } from '@reduxjs/toolkit'
import { addWalletCard, removeWalletCard, setWalletCardStatus } from '../data/api'
import { catalogReducer, loadCatalog } from './catalogSlice'
import { saveWalletState, loadWalletState } from './walletPersistence'
import { scoreReducer } from './scoreSlice'
import { walletActions, walletReducer } from './walletSlice'

const VERIFY_DELAY_MS = 2200
const DECLINE_DELAY_MS = 900
const verificationTimers = new Map<string, ReturnType<typeof setTimeout>>()

const listenerMiddleware = createListenerMiddleware()

function cancelVerification(id: string) {
  const timer = verificationTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    verificationTimers.delete(id)
  }
}

listenerMiddleware.startListening({
  actionCreator: walletActions.startVerification,
  effect: (action, listenerApi) => {
    const id = action.payload
    cancelVerification(id)
    const willDecline = typeof navigator !== 'undefined' && navigator.onLine === false
    const timer = setTimeout(
      () => {
        verificationTimers.delete(id)
        listenerApi.dispatch(
          walletActions.setVerificationStatus({
            id,
            status: willDecline ? 'failed' : 'verified',
            at: willDecline ? undefined : new Date().toISOString(),
          }),
        )
      },
      willDecline ? DECLINE_DELAY_MS : VERIFY_DELAY_MS,
    )
    verificationTimers.set(id, timer)
  },
})

listenerMiddleware.startListening({
  actionCreator: walletActions.toggleCard,
  effect: (action) => cancelVerification(action.payload),
})

listenerMiddleware.startListening({
  actionCreator: walletActions.reset,
  effect: () => {
    verificationTimers.forEach(clearTimeout)
    verificationTimers.clear()
  },
})

/**
 * Write-through to the server, for signed-in visitors only.
 *
 * The reducers stay synchronous and optimistic -- the picker must not wait on a
 * round trip -- so these listeners follow the local change with the API call.
 * `synced` is the gate: until the sign-in merge has run, the server does not
 * yet have this wallet and telling it about one card at a time would be wrong.
 *
 * A failure is logged rather than rolled back. Reverting a card someone just
 * tapped is its own kind of wrong, and the next sign-in merge reconciles what
 * drifted; what must not happen is silently believing a write landed.
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
      await (added ? addWalletCard(id) : removeWalletCard(id))
    } catch (err) {
      console.error(`Could not ${added ? 'add' : 'remove'} card '${id}' on the server`, err)
    }
  },
})

listenerMiddleware.startListening({
  actionCreator: walletActions.setVerificationStatus,
  effect: async (action, listenerApi) => {
    if (!isServerBacked(listenerApi.getState() as RootState)) return

    const { id, status } = action.payload
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
