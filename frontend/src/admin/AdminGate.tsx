import type { ReactNode } from 'react'
import { useMediaQuery } from '../hooks/useMediaQuery'
import styles from './AdminGate.module.css'

/**
 * Below this the console is unusable: the shell is a two-column master-detail
 * with tables in it. Wider than DesktopGate's 700px breakpoint on purpose --
 * there is a band between the two where neither the app nor the console runs,
 * and a tablet landing there should be told rather than shown a broken table.
 */
export const ADMIN_QUERY = '(min-width: 900px)'

/**
 * The mirror image of DesktopGate: the product is phones-only, the console is
 * desktop-only, and each refuses to mount the other's tree.
 *
 * A separate component rather than a `mode` prop on DesktopGate because the two
 * share only their mechanism -- the copy, the breakpoint and the audience are
 * all different, and keeping the console's chrome inside src/admin means the
 * consumer app is untouched by any of it.
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
