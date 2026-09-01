import { Button } from '../components/Button'
import { PUBLIC_DOMAIN } from '../data/brand'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { navigate } from '../router/hashRouter'
import styles from './LandingPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(124,58,237,0.55)', size: 460, top: -160, left: -120 },
  { color: 'rgba(56,189,248,0.28)', size: 420, top: 180, right: -180 },
  { color: 'rgba(49,46,129,0.75)', size: 520, bottom: -200, left: -60 },
]

export function LandingPage() {
  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.wordmark}>{PUBLIC_DOMAIN}</div>

      <div className={styles.bottom}>
        <div className={styles.stackWrap} aria-hidden="true">
          <div className={styles.stack}>
            <div className={styles.cardBack} />
            <div className={styles.cardMid} />
            <div className={styles.cardFront} />
          </div>
        </div>

        <h1 className={styles.title}>Your wallet has a rating.</h1>
        <p className={styles.blurb}>
          Add the cards you carry. Get a score out of 3000 and a profile worth sharing.
        </p>

        <Button
          className={styles.cta}
          onClick={() => navigate({ kind: 'wallet' })}
        >
          Build your wallet
        </Button>
      </div>
    </Screen>
  )
}
