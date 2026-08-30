import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/react'
import styles from './AuthBar.module.css'

/**
 * The app's only persistent chrome: sign in / sign up when there is no session,
 * the Clerk avatar menu once there is. It floats over the screen rather than
 * sitting in a header, because every page draws its own header and the design
 * has no global nav to hang this off.
 */
export function AuthBar() {
  return (
    <div className={styles.bar}>
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button type="button" className={styles.link}>
            Sign in
          </button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button type="button" className={styles.solid}>
            Sign up
          </button>
        </SignUpButton>
      </Show>

      <Show when="signed-in">
        <UserButton />
      </Show>
    </div>
  )
}
