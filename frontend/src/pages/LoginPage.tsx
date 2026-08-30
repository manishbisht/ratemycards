import { Button } from '../components/Button'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { navigate } from '../router/hashRouter'
import { useAppDispatch } from '../store/hooks'
import { walletActions } from '../store/walletSlice'
import styles from './LoginPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(124,58,237,0.45)', size: 460, top: 120, left: -160 },
  { color: 'rgba(20,184,166,0.2)', size: 440, bottom: -140, right: -160 },
]

export function LoginPage() {
  const dispatch = useAppDispatch()

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.panel}>
        <div className={styles.eyebrow}>Rate My Cards</div>
        <h2 className={styles.title}>Save your rating</h2>
        <p className={styles.blurb}>Sign in to keep your wallet and claim a public profile.</p>

        <Button
          className={styles.google}
          onClick={() => {
            dispatch(walletActions.signIn({ name: 'Arjun K', email: 'arjun@example.com' }))
            navigate({ kind: 'verify' })
          }}
        >
          <span className={styles.googleMark} aria-hidden="true" />
          Continue with Google
        </Button>

        <div className={styles.footnote}>
          We only read your name and email. Nothing is posted anywhere.
        </div>
      </div>
    </Screen>
  )
}
