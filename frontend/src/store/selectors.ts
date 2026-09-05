import { createSelector } from '@reduxjs/toolkit'
import type { Card, CardId } from '../data/cards'
import type { RootState } from './store'

export const selectWallet = (state: RootState) => state.wallet
export const selectCatalog = (state: RootState) => state.catalog.cards
export const selectCatalogStatus = (state: RootState) => state.catalog.status
export const selectPicked = (state: RootState) => state.wallet.picked
export const selectScoreAnswer = (state: RootState) => state.score.answer

/**
 * In the order the cards were picked, not the order the catalog lists them:
 * the decks show "the last four added", and a card the user just added has to
 * land at the end of the pile rather than wherever its name happens to sort.
 *
 * `picked` can name a card the catalog has since dropped, so ids that no
 * longer resolve fall out rather than becoming holes in the deck.
 */
export const selectChosenCards = createSelector([selectCatalog, selectPicked], (catalog, picked) => {
  const byId = new Map(catalog.map((card) => [card.id, card]))
  return picked
    .map((id) => byId.get(id))
    .filter((card): card is Card => card !== undefined)
})

export const selectVerifiedCards = createSelector(
  [selectChosenCards, (state: RootState) => state.wallet.vstatus],
  (chosenCards, statuses) => chosenCards.filter((card) => statuses[card.id] === 'verified'),
)

export function selectVerificationStatus(state: RootState, id: CardId) {
  return state.wallet.vstatus[id] ?? 'unverified'
}

export function selectVerifiedDate(state: RootState, id: CardId) {
  return state.wallet.verifiedAt[id]
}
