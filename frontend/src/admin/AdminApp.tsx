import { SignInButton } from '@clerk/react'
import type { AdminRoute } from '../router/hashRouter'
import { AdminBanksPage } from './AdminBanksPage'
import { AdminCardPage } from './AdminCardPage'
import { AdminCriteriaPage } from './AdminCriteriaPage'
import { AdminGate } from './AdminGate'
import { AdminNetworksPage } from './AdminNetworksPage'
import { useAdminSession } from './useAdminSession'
import styles from './AdminApp.module.css'

/**
 * The console's root: the desktop gate, then the access check, then a screen.
 *
 * Mounted instead of the consumer app rather than inside it, so none of the
 * phone chrome -- the PhoneFrame column, AuthBar, the Screen shell -- comes
 * along. The console wants the whole window.
 */
export function AdminApp({ route }: { route: AdminRoute }) {
  return (
    <AdminGate>
      <AdminBody route={route} />
    </AdminGate>
  )
}

function AdminBody({ route }: { route: AdminRoute }) {
  const session = useAdminSession()

  switch (session.status) {
    case 'loading':
      return <Access title="Checking access…" />

    case 'anonymous':
      return (
        <Access title="Sign in" body="The console is for admins. Sign in to continue.">
          {/* Clerk's modal rather than #/login: that page redirects a
              signed-in user straight into the consumer verify flow. */}
          <SignInButton mode="modal">
            <button type="button" className={styles.action}>
              Sign in
            </button>
          </SignInButton>
        </Access>
      )

    case 'denied':
      return (
        <Access
          title="No access"
          body="This account is not an admin. If that is wrong, it needs adding to ADMIN_EMAILS."
        >
          <a className={styles.action} href="#/">
            Back to the app
          </a>
        </Access>
      )

    case 'error':
      return (
        <Access title="Could not check access" body={session.message}>
          <button type="button" className={styles.action} onClick={() => window.location.reload()}>
            Retry
          </button>
        </Access>
      )

    case 'admin':
      return <AdminScreen route={route} />
  }
}

function AdminScreen({ route }: { route: AdminRoute }) {
  switch (route.kind) {
    case 'adminBanks':
      return <AdminBanksPage route={route} />
    case 'adminBank':
      return <AdminBanksPage route={route} bankId={route.bankId} />
    case 'adminCard':
      return <AdminCardPage route={route} cardId={route.cardId} />
    case 'adminNetworks':
      return <AdminNetworksPage route={route} />
    case 'adminCriteria':
      return <AdminCriteriaPage route={route} />
  }
}

function Access({
  title,
  body,
  children,
}: {
  title: string
  body?: string
  children?: React.ReactNode
}) {
  return (
    <div className={styles.access}>
      <div className={styles.panel}>
        <div className={styles.eyebrow}>Rate My Cards admin</div>
        <h1 className={styles.title}>{title}</h1>
        {body ? <p className={styles.body}>{body}</p> : null}
        {children}
      </div>
    </div>
  )
}
