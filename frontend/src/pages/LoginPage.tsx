import { useSignIn } from '@clerk/react'
import { useEffect, useState } from 'react'
import { ssoCallbackUrl, ssoCompleteUrl } from '../auth/ssoRedirect'
import { Button } from '../components/Button'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { navigate } from '../router/hashRouter'
import { useAppSelector } from '../store/hooks'
import { selectWallet } from '../store/selectors'
import styles from './LoginPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(124,58,237,0.45)', size: 460, top: 120, left: -160 },
  { color: 'rgba(20,184,166,0.2)', size: 440, bottom: -140, right: -160 },
]

export function LoginPage() {
  const { signIn, fetchStatus } = useSignIn()
  const signedIn = useAppSelector(selectWallet).user !== null
  const [error, setError] = useState<string | null>(null)

  // Covers arriving at #/login with a session already in hand; the Google round
  // trip itself returns to the site root and is routed on before this mounts.
  useEffect(() => {
    if (signedIn) navigate({ kind: 'verify' })
  }, [signedIn])

  async function continueWithGoogle() {
    setError(null)
    const result = await signIn.sso({
      strategy: 'oauth_google',
      redirectUrl: ssoCompleteUrl(),
      redirectCallbackUrl: ssoCallbackUrl(),
    })

    // A rejected start leaves the visitor on this screen, so it has to say so —
    // the redirect that would normally take over never happens.
    if (result.error) {
      setError(result.error.message ?? 'Could not start Google sign-in. Please try again.')
    }
  }

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.panel}>
        <div className={styles.eyebrow}>Rate My Cards</div>
        <h2 className={styles.title}>Save your rating</h2>
        <p className={styles.blurb}>Sign in to keep your wallet and claim a public profile.</p>

        <Button
          className={styles.google}
          disabled={fetchStatus === 'fetching'}
          onClick={continueWithGoogle}
        >
          <span className={styles.googleMark} aria-hidden="true" />
          {fetchStatus === 'fetching' ? 'Opening Google…' : 'Continue with Google'}
        </Button>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        <div className={styles.footnote}>
          We only read your name and email. Nothing is posted anywhere.
        </div>
      </div>
    </Screen>
  )
}
