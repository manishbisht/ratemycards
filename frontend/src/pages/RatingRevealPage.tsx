import { Button } from '../components/Button'
import { FannedDeck } from '../components/FannedDeck'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { TierPill } from '../components/TierPill'
import { summaryFor } from '../data/scoring'
import { navigate } from '../router/hashRouter'
import { useWalletScore } from '../state/useWalletScore'
import { useAppSelector } from '../store/hooks'
import { selectChosenCards, selectVerifiedCards, selectWallet } from '../store/selectors'
import styles from './RatingRevealPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(251,146,60,0.28)', size: 480, top: -140, left: -100 },
  { color: 'rgba(124,58,237,0.5)', size: 460, top: 240, right: -200 },
  { color: 'rgba(30,27,75,0.9)', size: 520, bottom: -220, left: -120 },
]

export function RatingRevealPage() {
  const state = useAppSelector(selectWallet)
  const chosenCards = useAppSelector(selectChosenCards)
  const verifiedCards = useAppSelector(selectVerifiedCards)

  const handle = state.handle
  const claimed = handle !== null

  // Cards are verified after sign-in, so the reveal shows a provisional rating
  // over everything picked until at least one card has been confirmed.
  const confirmed = verifiedCards.length > 0
  const shownCards = confirmed ? verifiedCards : chosenCards

  // This is the screen the Reveal button leads to, so this is where the score
  // is asked for -- the picker never fetches it.
  const shown = useWalletScore(shownCards.map((card) => card.id))
  const shownRating = shown.score.score
  const shownTier = shown.score.tier

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.panel}>
        <TierPill name={shownTier.name} color={shownTier.color} />
        <div className={styles.score} style={{ color: shownTier.color }}>
          {shownRating}
        </div>
        <div className={styles.outOf}>out of {shown.score.maxScore}</div>
        <div className={styles.divider} />
        <p className={styles.summary}>{summaryFor(shownRating, shownCards.length)}</p>
      </div>

      <FannedDeck cards={shownCards} className={styles.deck} />

      <div className={styles.caption}>
        {confirmed ? (
          <>
            <span className={styles.tick} aria-hidden="true">
              ✓
            </span>
            {verifiedCards.length} verified {verifiedCards.length === 1 ? 'card' : 'cards'}
          </>
        ) : (
          `${chosenCards.length} ${chosenCards.length === 1 ? 'card' : 'cards'} · not verified yet`
        )}
      </div>

      <div className={styles.footer}>
        <Button
          onClick={() =>
            navigate(
              claimed
                ? { kind: 'profile', username: handle }
                : !state.user
                  ? { kind: 'login' }
                  : // Signed in but nothing confirmed yet: verify before claiming.
                    confirmed
                    ? { kind: 'claim' }
                    : { kind: 'verify' },
            )
          }
        >
          {claimed ? `View ${handle}.ratemycards.in` : 'Claim yourname.ratemycards.in'}
        </Button>
        <div className={styles.footnote}>{claimed ? 'Your profile is live' : 'Free, takes a second'}</div>
      </div>
    </Screen>
  )
}
