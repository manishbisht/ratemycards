import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { CardRow } from '../components/CardRow'
import { ConfirmRemove } from '../components/ConfirmRemove'
import { DeckStrip } from '../components/DeckStrip'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import type { Card, CardId } from '../data/cards'
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
import type { VerificationStatus } from '../state/walletTypes'
import styles from './CardPickerPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(99,102,241,0.45)', size: 440, top: -180, right: -140 },
  { color: 'rgba(20,184,166,0.22)', size: 440, bottom: -160, left: -140 },
]

/**
 * Where a card sits in the list, lowest first.
 *
 * Ordered by what the card asks of the person looking at it. One they added but
 * have not proved wants a tap. One they could add is worth browsing. One
 * nothing can verify is a request for help rather than an offer. And one
 * already proved is finished business — still here, still removable, but it has
 * no claim on the top of the screen, which is why the filter above the list
 * exists to fetch that group back without scrolling.
 */
const RANK = { toVerify: 0, addable: 1, blocked: 2, verified: 3 }

function rankOf(
  card: Card,
  held: Set<CardId>,
  vstatus: Record<CardId, VerificationStatus>,
): number {
  // Asked first, and without consulting the wallet: "can't verify" is a fact
  // about the catalog, not about this person. A card they hold with no BIN
  // prefixes on file still cannot be proved by anybody, so it belongs with the
  // rest of the asks rather than in their to-verify pile.
  if (!card.selectable) return RANK.blocked
  if (!held.has(card.id)) return RANK.addable
  return (vstatus[card.id] ?? 'unverified') === 'verified' ? RANK.verified : RANK.toVerify
}

/**
 * The whole catalog already lives in the store -- `loadCatalog` fetches it once
 * on mount -- so this page neither fetches nor pages. It filters that array.
 *
 * That is why there is no debounce: matching a hundred-odd cards in memory on
 * every keystroke is free, and nothing is waiting on the network.
 */
export function CardPickerPage() {
  const [query, setQuery] = useState('')
  /**
   * Narrows the list to one group. Mutually exclusive rather than two
   * independent toggles: both on would mean "verified or waiting", which is
   * just the held cards, and neither on already means everything -- so a pair
   * of checkboxes would have two settings that say the same thing. Tapping the
   * active chip clears it. See RANK.
   */
  const [filter, setFilter] = useState<'all' | 'verified' | 'toVerify'>('all')
  /**
   * The verified card whose removal is being confirmed, if any. Verified is the
   * only state that asks: see ConfirmRemove.
   */
  const [confirming, setConfirming] = useState<string | null>(null)

  /**
   * Cancels out the jump that re-sorting causes.
   *
   * Adding a card moves it from the addable group up into to-verify, and
   * removing one sends it back down. Either way the rows BETWEEN its old and
   * new home slide by exactly one, so the list lurches under the finger that
   * just tapped it -- on a screen built to be tapped through quickly.
   *
   * Rather than assume a row height and scroll by it, this pins a row that is
   * not the one being tapped: remember where it sits before the dispatch, then
   * put the scroll back so it has not moved. That comes out as one card in the
   * ordinary case and, more usefully, as NOTHING when the tap changes no order
   * at all -- which is what happens on the two thirds of the catalog that
   * cannot be verified, since those stay in their own group either way. A blind
   * one-row scroll would introduce a jump on every one of those.
   */
  const results = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ id: string; top: number } | null>(null)

  const anchorBeforeToggle = useCallback((tappedId: string) => {
    const box = results.current
    anchor.current = null
    if (!box) return

    const boxTop = box.getBoundingClientRect().top
    for (const row of box.querySelectorAll<HTMLElement>('[data-card]')) {
      // The tapped row is the one that moves, so it cannot be the reference.
      if (row.dataset.card === tappedId) continue
      const top = row.getBoundingClientRect().top - boxTop
      // The first row at or below the top edge: the one a reader is anchored
      // on themselves.
      if (top >= 0) {
        anchor.current = { id: row.dataset.card as string, top }
        return
      }
    }
  }, [])

  // Before paint, so the correction is never a visible frame of its own.
  useLayoutEffect(() => {
    const pinned = anchor.current
    anchor.current = null
    const box = results.current
    if (!pinned || !box) return

    const row = box.querySelector<HTMLElement>(`[data-card="${pinned.id}"]`)
    if (!row) return

    const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top
    box.scrollTop += top - pinned.top
  })

  const dispatch = useAppDispatch()
  const state = useAppSelector(selectWallet)
  const catalog = useAppSelector(selectCatalog)
  const chosenCards = useAppSelector(selectChosenCards)
  const verifiedCards = useAppSelector(selectVerifiedCards)
  const catalogStatus = useAppSelector(selectCatalogStatus)
  const statusOf = (id: string) => state.vstatus[id] ?? 'unverified'

  const trimmed = query.trim()

  // Matches what the API's `q` used to search: the card's name or its issuer.
  //
  // Unselectable cards -- the two thirds of the catalog with no BIN prefixes on
  // file -- used to be dropped here, on the grounds that nothing can verify
  // them so offering them was a dead end. They are shown now. Hiding them made
  // the backlog invisible to the only people who can help close it: somebody
  // holding one of those cards knows its prefixes, and could not tell us
  // because they could not find the card. A card that cannot be verified yet
  // says so on its row, and asks.
  //
  // The list is then grouped by what each card ASKS OF YOU, nearest first --
  // see RANK. A flat alphabetical catalog buries the handful of rows that want
  // something under the hundred that do not.
  const shown = useMemo(() => {
    const needle = trimmed.toLowerCase()
    // A Set rather than `picked.includes`, which would be a linear scan.
    const held = new Set(state.picked)
    const wanted = filter === 'verified' ? RANK.verified : RANK.toVerify

    return (
      catalog
        // Ranked once per card rather than inside the comparator, which a sort
        // would call twice for each of its ~700 comparisons. It also gives the
        // filter below the same answer the ordering uses, so the two cannot
        // disagree about what "verified" means.
        .map((card) => ({ card, rank: rankOf(card, held, state.vstatus) }))
        .filter(({ card, rank }) => {
          if (filter !== 'all' && rank !== wanted) return false
          return (
            !needle ||
            card.name.toLowerCase().includes(needle) ||
            card.issuer.toLowerCase().includes(needle)
          )
        })
        // `map` already returned a fresh array, so this sorts a copy and never
        // the store's own. Sort is stable, so the catalog's ordering survives
        // inside each group.
        .sort((a, b) => a.rank - b.rank)
        .map(({ card }) => card)
    )
  }, [catalog, trimmed, filter, state.picked, state.vstatus])

  // One loading path and one error path, both the catalog's -- this page no
  // longer has any request of its own to be in flight.
  const loading = catalogStatus === 'idle' || catalogStatus === 'loading'
  const failed = catalogStatus === 'error'

  const chosenCount = chosenCards.length
  const verifiedCount = verifiedCards.length
  // Held cards that nothing can verify, because no BIN prefix is on file.
  const blockedCount = chosenCards.filter((card) => !card.selectable).length
  // Held, verifiable, still unproved -- RANK.toVerify, and the same number the
  // summary line below calls "not counted".
  const toVerifyCount = chosenCount - verifiedCount - blockedCount

  const signedIn = state.user !== null
  const cta = signedIn ? primaryCta(chosenCount, verifiedCount, blockedCount) : 'Reveal'
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

      {/* Only when signed in and holding something: before that both groups are
          empty, and a filter that can only empty the list is not a control.
          Both chips render together so the row does not reflow as counts move
          between them; a group with nothing in it is disabled rather than
          missing, which says "none yet" instead of quietly vanishing. */}
      {signedIn && chosenCount > 0 ? (
        <div className={styles.filters}>
          <button
            type="button"
            className={filter === 'toVerify' ? styles.chipOnPlain : styles.chip}
            aria-pressed={filter === 'toVerify'}
            disabled={toVerifyCount === 0}
            onClick={() => setFilter((f) => (f === 'toVerify' ? 'all' : 'toVerify'))}
          >
            Unverified
            <span className={styles.chipCount}>{toVerifyCount}</span>
          </button>
          <button
            type="button"
            className={filter === 'verified' ? styles.chipOn : styles.chip}
            aria-pressed={filter === 'verified'}
            disabled={verifiedCount === 0}
            onClick={() => setFilter((f) => (f === 'verified' ? 'all' : 'verified'))}
          >
            Verified
            <span className={styles.chipCount}>{verifiedCount}</span>
          </button>
        </div>
      ) : null}

      <div className={styles.results} ref={results} aria-busy={loading}>
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
            {filter === 'verified'
              ? trimmed
                ? `No verified cards match “${trimmed}”.`
                : 'No verified cards yet.'
              : filter === 'toVerify'
                ? trimmed
                  ? `No unverified cards match “${trimmed}”.`
                  : 'Nothing left to verify.'
                : trimmed
                  ? `No cards match “${trimmed}”.`
                  : 'No cards in the catalog yet.'}
            {trimmed && filter === 'all' ? (
              <div>
                <button
                  type="button"
                  className={styles.retry}
                  onClick={() => navigate({ kind: 'requests', cardId: null })}
                >
                  Ask us to add it
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          shown.map((card) => {
            const on = state.picked.includes(card.id)
            const status = statusOf(card.id)

            // Only the verification state ever appears here. A card's own
            // rating is not published, so there is nothing else to show.
            const showVerification = on && signedIn
            // A card with no BIN prefixes on file cannot be verified by
            // anybody, held or not, so this is said on every row rather than
            // only the picked ones -- it explains why the card is greyer.
            const unverifiable = !card.selectable
            // The one tap on this screen that costs something. Everything else
            // stays a single tap -- a picker is for tapping through quickly,
            // and a card you have not proved costs a tap to put back.
            const guarded = on && status === 'verified'

            return (
              <div key={card.id} data-card={card.id}>
                <CardRow
                  name={card.name}
                  issuer={card.issuer}
                  status={
                    unverifiable
                      ? // No longer than 'Not verified', the longest of the
                        // verification labels: `.status` in CardRow is nowrap
                        // with wide letter-spacing, so anything broader eats
                        // the card name -- on two thirds of the rows.
                        'Can’t verify'
                      : showVerification
                        ? STATUS_LABEL[status]
                        : undefined
                  }
                  statusColor={unverifiable ? 'var(--text-muted)' : STATUS_COLOR[status]}
                  mark={on ? '−' : '+'}
                  onClick={() => {
                    if (guarded) {
                      setConfirming((current) => (current === card.id ? null : card.id))
                      return
                    }
                    anchorBeforeToggle(card.id)
                    dispatch(walletActions.toggleCard(card.id))
                  }}
                />
                {/* Only for a card they actually hold: 67 of 100 cards are
                    unverifiable, and a strip under every one of them would be
                    the whole list. Holding it is the signal that this person
                    is the one who can read the prefixes off it. */}
                {on && unverifiable ? (
                  <button
                    type="button"
                    className={styles.askForBins}
                    onClick={() => navigate({ kind: 'requests', cardId: card.id })}
                  >
                    We can’t verify this one yet — help us add it →
                  </button>
                ) : null}
                {confirming === card.id ? (
                  <ConfirmRemove
                    name={card.name}
                    className={styles.confirm}
                    onConfirm={() => {
                      setConfirming(null)
                      anchorBeforeToggle(card.id)
                      dispatch(walletActions.toggleCard(card.id))
                    }}
                    onCancel={() => setConfirming(null)}
                  />
                ) : null}
              </div>
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
              {signedIn
                ? verifyLine(chosenCount, verifiedCount, blockedCount)
                : pickedLine(chosenCount)}
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
