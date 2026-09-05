import { Button } from '../components/Button'
import { PUBLIC_DOMAIN } from '../data/brand'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { cardArtSrc } from '../data/cardArt'
import { navigate } from '../router/hashRouter'
import { useLandingDestination } from '../router/useLandingDestination'
import styles from './LandingPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(124,58,237,0.55)', size: 460, top: -160, left: -120 },
  { color: 'rgba(56,189,248,0.28)', size: 420, top: 180, right: -180 },
  { color: 'rgba(49,46,129,0.75)', size: 520, bottom: -200, left: -60 },
]

export function LandingPage() {
  // A signed-in visitor who already has a wallet is on their way elsewhere.
  // Only the wordmark renders until that is decided -- the glows and the
  // wordmark sit outside the branch, so arriving at the pitch adds to the
  // screen rather than replacing it, and the cards deal in as they always did.
  const destination = useLandingDestination()

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.wordmark}>{PUBLIC_DOMAIN}</div>

      {destination === 'stay' && (
        <div className={styles.bottom}>
          <div
            className={styles.stackWrap}
            role="img"
            aria-label="A wallet of three cards: Axis Olympus, HDFC Infinia and American Express Platinum Charge."
          >
            {/* Fixed art rather than catalog data: the landing screen paints
                before the API has been asked for anything. Back of the stack
                first, so each card overlaps the one behind it. */}
            <div className={styles.stack}>
              <img
                className={styles.cardBack}
                src={cardArtSrc('American Express', 'Platinum Charge Card')}
                alt=""
              />
              <img className={styles.cardMid} src={cardArtSrc('HDFC', 'Infinia Metal')} alt="" />
              <img className={styles.cardFront} src={cardArtSrc('Axis', 'Olympus')} alt="" />
            </div>
          </div>

          <h1 className={styles.title}>Your wallet has a rating.</h1>
          <p className={styles.blurb}>
            Add the cards you carry. Get a score out of 3000 and a profile worth sharing.
          </p>

          <Button className={styles.cta} onClick={() => navigate({ kind: 'wallet' })}>
            Build your wallet
          </Button>
        </div>
      )}
    </Screen>
  )
}
