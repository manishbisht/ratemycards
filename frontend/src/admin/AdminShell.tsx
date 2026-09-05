import { UserButton } from '@clerk/react'
import type { ReactNode } from 'react'
import { hrefFor } from '../router/hashRouter'
import type { AdminRoute } from '../router/hashRouter'
import styles from './AdminShell.module.css'

/**
 * The console's frame: a fixed header, a left rail, and a content pane that
 * scroll independently.
 *
 * Deliberately not built on `<Screen>`, which is 100dvh with overflow hidden
 * and carries glows positioned for a 390px phone frame. A tool wants a grid
 * whose regions scroll on their own, which also sidesteps the global
 * `overscroll-behavior-y: none` in base.css.
 */

const SECTIONS = [
  { label: 'Banks', route: { kind: 'adminBanks' } as const },
  { label: 'Networks', route: { kind: 'adminNetworks' } as const },
  { label: 'Rubric', route: { kind: 'adminCriteria' } as const },
  { label: 'Requests', route: { kind: 'adminRequests' } as const },
]

/** Which nav item to light up. Bank and card screens both live under Banks. */
function sectionFor(route: AdminRoute): string {
  switch (route.kind) {
    case 'adminNetworks':
      return 'Networks'
    case 'adminCriteria':
      return 'Rubric'
    case 'adminRequests':
      return 'Requests'
    default:
      return 'Banks'
  }
}

export function AdminShell({
  route,
  rail,
  children,
}: {
  route: AdminRoute
  /** Omitted on full-width screens, e.g. the card editor. */
  rail?: ReactNode
  children: ReactNode
}) {
  const current = sectionFor(route)

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <a className={styles.brand} href={hrefFor({ kind: 'landing' })}>
          Rate My Cards <span className={styles.brandTag}>admin</span>
        </a>

        <nav className={styles.nav}>
          {SECTIONS.map((section) => (
            <a
              key={section.label}
              className={section.label === current ? styles.navItemOn : styles.navItem}
              href={hrefFor(section.route)}
              aria-current={section.label === current ? 'page' : undefined}
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className={styles.account}>
          <UserButton />
        </div>
      </header>

      <div className={rail ? styles.bodyWithRail : styles.body}>
        {rail ? <aside className={styles.rail}>{rail}</aside> : null}
        <main className={styles.pane}>{children}</main>
      </div>
    </div>
  )
}
