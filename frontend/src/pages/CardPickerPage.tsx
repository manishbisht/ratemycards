import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { CardRow } from '../components/CardRow'
import { DeckStrip } from '../components/DeckStrip'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { fetchCards } from '../data/api'
import type { Card } from '../data/cards'
import { pickedLine, primaryCta, verifyLine } from '../data/scoring'
import { STATUS_COLOR, STATUS_LABEL } from '../data/verification'
import { useDebounced } from '../hooks/useDebounced'
import { navigate } from '../router/hashRouter'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { selectCatalogStatus, selectChosenCards, selectVerifiedCards, selectWallet } from '../store/selectors'
import { walletActions } from '../store/walletSlice'
import styles from './CardPickerPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(99,102,241,0.45)', size: 440, top: -180, right: -140 },
  { color: 'rgba(20,184,166,0.22)', size: 440, bottom: -160, left: -140 },
]

/** The list scrolls, so this is a page size rather than the design's old cap of 5. */
const RESULT_LIMIT = 25
const SEARCH_DEBOUNCE_MS = 200

/** Tagged with the query it answers, so loading is derived, not written. */
type Results = { key: string; cards: Card[]; total: number; failed: boolean }

export function CardPickerPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results | null>(null)
  const [attempt, setAttempt] = useState(0)

  const dispatch = useAppDispatch()
  const state = useAppSelector(selectWallet)
  const chosenCards = useAppSelector(selectChosenCards)
  const verifiedCards = useAppSelector(selectVerifiedCards)
  const catalogStatus = useAppSelector(selectCatalogStatus)
  const statusOf = (id: string) => state.vstatus[id] ?? 'unverified'

  const settledQuery = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS)

  const requestKey = `${attempt}:${settledQuery}`

  useEffect(() => {
    const controller = new AbortController()
    const key = requestKey

    fetchCards({ q: settledQuery || undefined, limit: RESULT_LIMIT }, controller.signal)
      .then((page) => setResults({ key, cards: page.cards, total: page.total, failed: false }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setResults({ key, cards: [], total: 0, failed: true })
      })

    return () => controller.abort()
  }, [requestKey, settledQuery])

  const loading = results === null || results.key !== requestKey

  const chosenCount = chosenCards.length
  const verifiedCount = verifiedCards.length

  const signedIn = state.user !== null
  const cta = signedIn ? primaryCta(chosenCount, verifiedCount) : 'Reveal'
  const ready = cta === 'Reveal'
  const dim = 'rgba(255,255,255,0.35)'

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.back}
          onClick={() => navigate({ kind: 'landing' })}
          aria-label="Back"
        >
          ←
        </button>
        <div className={styles.heading}>Your wallet</div>
      </div>

      <div className={styles.search}>
        <span className={styles.searchIcon} aria-hidden="true">
          ⌕
        </span>
        <input
          className={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a card or bank"
          aria-label="Search a card or bank"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </div>

      <div className={styles.results} aria-busy={loading}>
        {loading ? (
          <div className={styles.empty}>Loading cards…</div>
        ) : results.failed ? (
          <div className={styles.empty}>
            Could not load the catalog.
            <div>
              <button type="button" className={styles.retry} onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          </div>
        ) : results.cards.length === 0 ? (
          <div className={styles.empty}>
            {settledQuery ? `No cards match “${settledQuery}”.` : 'No cards in the catalog yet.'}
          </div>
        ) : (
          results.cards.map((card) => {
            const on = state.picked.includes(card.id)
            const status = statusOf(card.id)

            // Only the verification state ever appears here. A card's own
            // rating is not published, so there is nothing else to show.
            const showVerification = on && signedIn
            return (
              <CardRow
                key={card.id}
                name={card.name}
                issuer={card.issuer}
                status={showVerification ? STATUS_LABEL[status] : undefined}
                statusColor={STATUS_COLOR[status]}
                mark={on ? '−' : '+'}
                onClick={() => dispatch(walletActions.toggleCard(card.id))}
              />
            )
          })
        )}
      </div>

      <div className={styles.footer}>
        <DeckStrip cards={chosenCards} statusOf={statusOf} showStatus={signedIn} />

        <div className={styles.bar}>
          <div>
            <div className={styles.barLabel}>{signedIn ? 'Verified rating' : 'Your rating'}</div>
            <div className={styles.barScoreRow}>
              {/* The rating stays hidden until the user asks for it. */}
              <div className={styles.barScore} style={{ color: dim }} aria-label="Rating hidden">
                ···
              </div>
            </div>
            <div className={styles.barLine}>
              {signedIn ? verifyLine(chosenCount, verifiedCount) : pickedLine(chosenCount)}
            </div>
          </div>
          <Button
            variant="compact"
            disabled={chosenCount === 0 || catalogStatus !== 'ready'}
            onClick={() => navigate({ kind: ready ? 'rating' : 'verify' })}
          >
            {cta}
          </Button>
        </div>
      </div>
    </Screen>
  )
}
