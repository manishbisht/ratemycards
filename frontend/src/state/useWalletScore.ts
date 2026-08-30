import { useEffect } from 'react'
import { EMPTY_SCORE } from '../data/api'
import type { WalletScore } from '../data/api'
import type { CardId } from '../data/cards'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { selectScoreAnswer } from '../store/selectors'
import { loadWalletScore } from '../store/scoreSlice'

/** Long enough to coalesce a burst of taps, short enough to feel immediate. */
const DEBOUNCE_MS = 180

export type ScoreState = {
  score: WalletScore
  /** A newer score is in flight; the one on screen is the previous answer. */
  pending: boolean
  failed: boolean
}

/**
 * Scores a set of cards through the API. The previous score stays on screen
 * while a new one is in flight, so the number never flickers back to zero
 * mid-edit; the Redux answer is keyed to its input, so `pending` is derived
 * rather than stored.
 */
export function useWalletScore(cardIds: CardId[]): ScoreState {
  // Joined so the effect compares by value: a fresh array of the same ids
  // would otherwise refetch on every render.
  const key = cardIds.join(',')
  const dispatch = useAppDispatch()
  const answer = useAppSelector(selectScoreAnswer)

  useEffect(() => {
    if (key === '') return

    let request: { abort: () => void } | undefined
    const timer = setTimeout(() => {
      request = dispatch(loadWalletScore({ key, cardIds: key.split(',') }))
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      request?.abort()
    }
  }, [dispatch, key])

  // An empty wallet needs no request, so its score is derived outright.
  if (key === '') return { score: EMPTY_SCORE, pending: false, failed: false }

  return {
    score: answer?.score ?? EMPTY_SCORE,
    pending: answer?.key !== key,
    failed: answer?.key === key && answer.failed,
  }
}
