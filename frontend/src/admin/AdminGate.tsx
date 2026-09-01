import type { ReactNode } from 'react'
import { useMediaQuery } from '../hooks/useMediaQuery'
import styles from './AdminGate.module.css'

/**
 * Below this the console is unusable: the shell is a two-column master-detail
 * with tables in it. A tablet landing under it should be told, rather than
 * shown a table with no room to be one.
 */
export const ADMIN_QUERY = '(min-width: 900px)'

/**
 * The console's counterpart to PhoneFrame. The app adapts to any width -- it
 * runs as a centred phone column once there is room -- but the console cannot:
 * a master-detail with tables in it has a floor, and below that floor there is
 * nothing sensible to render.
 *
 * So this is the one place left that refuses rather than adapts, and it lives
 * in src/admin so the consumer app is untouched by it.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const isWideEnough = useMediaQuery(ADMIN_QUERY)

  if (isWideEnough) return <>{children}</>

  return (
    <div className={styles.gate}>
      <div className={styles.panel}>
        <div className={styles.eyebrow}>Rate My Cards</div>
        <h1 className={styles.title}>Admin needs a laptop.</h1>
        <p className={styles.body}>
          The console edits banks, cards and BIN prefixes in tables that do not
          fit a phone. Open this page on a wider screen.
        </p>
        <a className={styles.back} href="#/">
          Back to the app
        </a>
      </div>
    </div>
  )
}
