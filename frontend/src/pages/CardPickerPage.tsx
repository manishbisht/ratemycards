import { useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { CardRow } from '../components/CardRow'
import { DeckStrip } from '../components/DeckStrip'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { pickedLine, primaryCta, verifyLine } from '../data/scoring'
import { STATUS_COLOR, STATUS_LABEL } from '../data/verification'
import { navigate } from '../router/hashRouter'
import { loadCatalog } from '../store/catalogSlice'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import {
  selectCatalog,
  selectCatalogStatus,
  selectChosenCards,
  selectVerifiedCards,
  selectWallet,
} from '../store/selectors'
import { walletActions } from '../store/walletSlice'
import styles from './CardPickerPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(99,102,241,0.45)', size: 440, top: -180, right: -140 },
  { color: 'rgba(20,184,166,0.22)', size: 440, bottom: -160, left: -140 },
]

/**
 * The whole catalog already lives in the store -- `loadCatalog` fetches it once
 * on mount -- so this page neither fetches nor pages. It filters that array.
 *
 * That is why there is no debounce: matching a hundred-odd cards in memory on
 * every keystroke is free, and nothing is waiting on the network.
 */
export function CardPickerPage() {
  const [query, setQuery] = useState('')

  const dispatch = useAppDispatch()
  const state = useAppSelector(selectWallet)
  const catalog = useAppSelector(selectCatalog)
  const chosenCards = useAppSelector(selectChosenCards)
  const verifiedCards = useAppSelector(selectVerifiedCards)
  const catalogStatus = useAppSelector(selectCatalogStatus)
  const statusOf = (id: string) => state.vstatus[id] ?? 'unverified'

  const trimmed = query.trim()

  // Matches what the API's `q` used to search: the card's name or its issuer.
  // Also drops any unselectable card -- one with no BIN prefixes on file --
  // since nothing can verify it, so offering it in the picker would be a dead
  // end. The catalog itself still carries these cards; only the picker hides
  // them.
  const shown = useMemo(() => {
    const needle = trimmed.toLowerCase()
    return catalog.filter(
      (card) =>
        card.selectable &&
        (!needle ||
          card.name.toLowerCase().includes(needle) ||
          card.issuer.toLowerCase().includes(needle)),
    )
  }, [catalog, trimmed])

  // One loading path and one error path, both the catalog's -- this page no
  // longer has any request of its own to be in flight.
  const loading = catalogStatus === 'idle' || catalogStatus === 'loading'
  const failed = catalogStatus === 'error'

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
        ) : failed ? (
          <div className={styles.empty}>
            Could not load the catalog.
            <div>
              <button
                type="button"
                className={styles.retry}
                onClick={() => void dispatch(loadCatalog())}
              >
                Try again
              </button>
            </div>
          </div>
        ) : shown.length === 0 ? (
          <div className={styles.empty}>
            {trimmed ? `No cards match “${trimmed}”.` : 'No cards in the catalog yet.'}
          </div>
        ) : (
          shown.map((card) => {
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
