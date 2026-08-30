import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import { EMPTY_SCORE, previewWallet } from '../data/api'
import type { WalletScore } from '../data/api'
import type { CardId } from '../data/cards'

export type ScoreAnswer = { key: string; score: WalletScore; failed: boolean }

type ScoreState = { answer: ScoreAnswer | null }

const initialState: ScoreState = { answer: null }

export const loadWalletScore = createAsyncThunk(
  'score/load',
  async ({ key, cardIds }: { key: string; cardIds: CardId[] }, { signal }) => ({
    key,
    score: await previewWallet(cardIds, signal),
  }),
)

export const scoreSlice = createSlice({
  name: 'score',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadWalletScore.fulfilled, (state, action) => {
        state.answer = { ...action.payload, failed: false }
      })
      .addCase(loadWalletScore.rejected, (state, action) => {
        if (action.meta.aborted) return
        state.answer = {
          key: action.meta.arg.key,
          score: state.answer?.score ?? EMPTY_SCORE,
          failed: true,
        }
      })
  },
})

export const scoreReducer = scoreSlice.reducer
