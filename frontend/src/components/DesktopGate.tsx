import type { ReactNode } from 'react'
import { useMediaQuery } from '../hooks/useMediaQuery'
import styles from './DesktopGate.module.css'

/** Phones, and phones in landscape, sit below this. */
export const MOBILE_QUERY = '(max-width: 700px)'

/**
 * Rate My Cards is mobile-only for now, so anything wider gets a message
 * instead of the app — the page tree below never mounts.
 *
 * Gating is on viewport width rather than user agent so it tracks resizing and
 * rotation honestly. `shouldGate` is a single boolean: exempting a route (the
 * shareable `#u/<handle>` profile is the likely first candidate, since those
 * links do get opened on laptops) is a one-line change here.
 */
export function DesktopGate({ children }: { children: ReactNode }) {
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const shouldGate = !isMobile

  if (!shouldGate) return <>{children}</>

  return (
    <div className={styles.gate}>
      <div className={styles.glowA} />
      <div className={styles.glowB} />
      <div className={styles.panel}>
        <div className={styles.eyebrow}>Rate My Cards</div>
        <h1 className={styles.title}>Built for phones.</h1>
        <p className={styles.body}>
          Rate My Cards only works on mobile for now. Open{' '}
          <span className={styles.url}>ratemycards.in</span> on your phone to build your wallet and
          get your rating.
        </p>
        <div className={styles.hint}>Already on a phone? Try rotating to portrait.</div>
      </div>
    </div>
  )
}
