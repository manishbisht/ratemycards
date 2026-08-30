import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { checkHandle, HANDLE_MAX, HANDLE_MIN } from '../data/handles'
import { navigate } from '../router/hashRouter'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { selectChosenCards, selectWallet } from '../store/selectors'
import { walletActions } from '../store/walletSlice'
import styles from './ClaimHandlePage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(99,102,241,0.42)', size: 420, top: -120, right: -140 },
  { color: 'rgba(76,29,149,0.6)', size: 460, bottom: -180, left: -120 },
]

export function ClaimHandlePage() {
  const dispatch = useAppDispatch()
  const state = useAppSelector(selectWallet)
  const chosenCards = useAppSelector(selectChosenCards)
  const [handle, setHandle] = useState(state.handle ?? '')

  // Claiming is the end of the flow: sign in, verify at least one card, then
  // pick a handle. Deep links that skip a step land on the step they skipped,
  // so a public profile never exists with nothing verified behind it.
  const signedIn = state.user !== null
  const confirmed = chosenCards.some((card) => state.vstatus[card.id] === 'verified')
  useEffect(() => {
    if (!signedIn) navigate({ kind: 'login' })
    else if (!confirmed) navigate({ kind: 'verify' })
  }, [signedIn, confirmed])

  if (!signedIn || !confirmed) return null

  const check = checkHandle(handle)
  const color = check.state === 'empty' ? 'rgba(255,255,255,0.35)' : check.available ? '#34D399' : '#F87171'
  const borderColor =
    check.state === 'empty'
      ? 'rgba(255,255,255,0.12)'
      : check.available
        ? 'rgba(52,211,153,0.5)'
        : 'rgba(248,113,113,0.5)'

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <h2 className={styles.title}>Pick your handle</h2>
      <p className={styles.blurb}>This becomes your public profile address.</p>

      <div className={styles.panel}>
        <div className={styles.label}>Your URL</div>
        <div className={styles.url}>
          <span style={{ color }}>{check.normalized || 'yourname'}</span>
          <span className={styles.domain}>.ratemycards.in</span>
        </div>

        <div className={styles.field} style={{ borderColor }}>
          <input
            className={styles.input}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="yourname"
            aria-label="Your handle"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={HANDLE_MAX}
          />
          <span className={styles.icon} style={{ color }} aria-hidden="true">
            {check.state === 'empty' ? '' : check.available ? '✓' : '✕'}
          </span>
        </div>
        <div className={styles.message} style={{ color }} role="status">
          {check.message}
        </div>
      </div>

      <div className={styles.footer}>
        <Button
          disabled={!check.available}
          onClick={() => {
            dispatch(walletActions.claimHandle(check.normalized))
            navigate({ kind: 'profile', username: check.normalized })
          }}
        >
          Claim handle
        </Button>
        <div className={styles.footnote}>
          Letters, numbers and underscores. {HANDLE_MIN}–{HANDLE_MAX} characters.
        </div>
      </div>
    </Screen>
  )
}
