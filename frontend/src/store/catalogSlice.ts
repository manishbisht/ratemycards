import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import { fetchCards } from '../data/api'
import type { Card } from '../data/cards'

/**
 * The API caps `limit` at 100, so this is a page size, not the catalog size --
 * loadCatalog pages until it has everything.
 */
const CATALOG_PAGE = 100

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error'

type CatalogState = {
  cards: Card[]
  total: number
  status: CatalogStatus
}

const initialState: CatalogState = { cards: [], total: 0, status: 'idle' }

/**
 * Loads the WHOLE catalog, including unselectable cards, one page per request.
 *
 * It has to be whole rather than the first page: `selectChosenCards` resolves a
 * wallet by filtering this array, so a card missing from it disappears from the
 * user's deck, the verify screen and the rating. The prune listener in store.ts
 * also refuses to run until `cards.length >= total`, for the same reason.
 *
 * `includeUnselectable: true` goes on every page, not just the first, because
 * the server's BIN gate would otherwise shrink `total` to only the selectable
 * cards -- which is exactly what satisfied the prune listener's guard and made
 * it delete held-but-unselectable cards from the wallet. Both the prune
 * listener and `selectChosenCards` need every card that exists; it is
 * `CardPickerPage` that filters on `selectable`, not this loader.
 *
 * `status` stays 'loading' across every page, so nothing downstream sees a
 * half-loaded catalog as ready.
 */
export const loadCatalog = createAsyncThunk('catalog/load', async (_, { signal }) => {
  const first = await fetchCards({ limit: CATALOG_PAGE, includeUnselectable: true }, signal)
  const cards = [...first.cards]

  // Taken from the first page and then left alone. If the catalog grows while
  // this is running we stop at the count we were told, rather than chasing a
  // moving target; the next load picks the rest up.
  const total = first.total

  while (cards.length < total) {
    const page = await fetchCards(
      { limit: CATALOG_PAGE, offset: cards.length, includeUnselectable: true },
      signal,
    )

    // A page that comes back empty while `total` still claims there is more
    // would otherwise spin forever. Stop and report what we have.
    if (page.cards.length === 0) break

    cards.push(...page.cards)
  }

  return { cards, total }
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
