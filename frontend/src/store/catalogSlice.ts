import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import { fetchCards } from '../data/api'
import type { Card } from '../data/cards'

const CATALOG_LIMIT = 100

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error'

type CatalogState = {
  cards: Card[]
  total: number
  status: CatalogStatus
}

const initialState: CatalogState = { cards: [], total: 0, status: 'idle' }

export const loadCatalog = createAsyncThunk('catalog/load', async (_, { signal }) => {
  return fetchCards({ limit: CATALOG_LIMIT }, signal)
})

export const catalogSlice = createSlice({
  name: 'catalog',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(loadCatalog.pending, (state) => {
        state.cards = []
        state.total = 0
        state.status = 'loading'
      })
      .addCase(loadCatalog.fulfilled, (state, action) => {
        state.cards = action.payload.cards
        state.total = action.payload.total
        state.status = 'ready'
      })
      .addCase(loadCatalog.rejected, (state, action) => {
        if (!action.meta.aborted) state.status = 'error'
      })
  },
})

export const catalogReducer = catalogSlice.reducer
