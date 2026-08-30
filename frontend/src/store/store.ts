import { configureStore, createListenerMiddleware } from '@reduxjs/toolkit'
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
