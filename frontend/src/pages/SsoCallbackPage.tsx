import { AuthenticateWithRedirectCallback } from '@clerk/react'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import styles from './SsoCallbackPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(124,58,237,0.45)', size: 460, top: 120, left: -160 },
  { color: 'rgba(20,184,166,0.2)', size: 440, bottom: -140, right: -160 },
]

/**
 * The far side of the Google round trip. Clerk sends people here when the
 * account needs a step beyond signing in — a first-time visitor, whose OAuth
 * sign-in has to become a sign-up. `AuthenticateWithRedirectCallback` carries
 * that out and navigates on, so this screen only has to say something while it
 * works.
 */
export function SsoCallbackPage() {
  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.note}>Finishing sign-in…</div>
      <AuthenticateWithRedirectCallback signUpFallbackRedirectUrl="/#/verify" />
    </Screen>
  )
}
