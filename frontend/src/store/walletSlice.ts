import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { CardId } from '../data/cards'
import { initialWalletState } from './walletPersistence'
import type { User, VerificationStatus } from '../state/walletTypes'

function omitKey<T>(source: Record<string, T>, key: string): Record<string, T> {
  if (!(key in source)) return source

  const next: Record<string, T> = {}
  for (const currentKey of Object.keys(source)) {
    if (currentKey !== key) next[currentKey] = source[currentKey]
  }
  return next
}

export const walletSlice = createSlice({
  name: 'wallet',
  initialState: initialWalletState,
  reducers: {
    toggleCard(state, action: PayloadAction<CardId>) {
      const id = action.payload
      if (!state.picked.includes(id)) {
        state.picked.push(id)
        return
      }

      state.picked = state.picked.filter((pickedId) => pickedId !== id)
      state.vstatus = omitKey(state.vstatus, id)
      state.verifiedAt = omitKey(state.verifiedAt, id)
    },
    startVerification(state, action: PayloadAction<CardId>) {
      state.vstatus[action.payload] = 'pending'
    },
    setVerificationStatus(
      state,
      action: PayloadAction<{ id: CardId; status: VerificationStatus; at?: string }>,
    ) {
      const { id, status, at } = action.payload
      state.vstatus[id] = status
      if (status === 'verified' && at) state.verifiedAt[id] = at
    },
    signIn(state, action: PayloadAction<User>) {
      state.user = action.payload
    },
    claimHandle(state, action: PayloadAction<string>) {
      state.handle = action.payload
    },
    pruneCards(state, action: PayloadAction<CardId[]>) {
      const validIds = new Set(action.payload)
      for (const id of [...state.picked]) {
        if (!validIds.has(id)) {
          state.picked = state.picked.filter((pickedId) => pickedId !== id)
          state.vstatus = omitKey(state.vstatus, id)
          state.verifiedAt = omitKey(state.verifiedAt, id)
        }
      }
    },
    reset: () => initialWalletState,
  },
})

export const walletActions = walletSlice.actions
export const walletReducer = walletSlice.reducer
