import type { ReactNode } from 'react'
import styles from './PhoneFrame.module.css'

/**
 * Rate My Cards is designed as a phone screen, so on anything wider it runs as
 * a centred column with the backdrop showing either side rather than as a
 * stretched layout it was never drawn for.
 *
 * This replaces the notice that used to refuse desktop outright. Refusing cost
 * more than it saved: the shareable `#/u/<handle>` profile is a link people open
 * on a laptop, and it answered them with "open this on your phone".
 *
 * Deliberately CSS-only -- no media-query hook, no conditional mounting. The
 * column is `max-width`, which simply does not bind on a phone, so there is one
 * code path for both and nothing remounts or flashes when a window is resized
 * across the breakpoint.
 */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <div className={styles.backdrop} aria-hidden="true">
        <div className={styles.glowA} />
        <div className={styles.glowB} />
      </div>
      <div className={styles.frame}>{children}</div>
    </>
  )
}
