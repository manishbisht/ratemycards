import { createSelector } from '@reduxjs/toolkit'
import type { CardId } from '../data/cards'
import type { RootState } from './store'

export const selectWallet = (state: RootState) => state.wallet
export const selectCatalog = (state: RootState) => state.catalog.cards
export const selectCatalogStatus = (state: RootState) => state.catalog.status
export const selectPicked = (state: RootState) => state.wallet.picked
export const selectScoreAnswer = (state: RootState) => state.score.answer

export const selectChosenCards = createSelector([selectCatalog, selectPicked], (catalog, picked) =>
  catalog.filter((card) => picked.includes(card.id)),
)

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
