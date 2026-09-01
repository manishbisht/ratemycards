import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { ApiError } from '../data/api'
import { checkHandleAvailability, claimHandle } from '../data/api'
import { PROFILE_PREFIX } from '../data/brand'
import { checkHandleShape, HANDLE_MAX, HANDLE_MIN } from '../data/handles'
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

  const check = checkHandleShape(handle)

  // 'unknown' until the server answers. Keyed to the handle it describes, so a
  // late reply for a name that has since been edited is ignored rather than
  // shown against the new one.
  const [availability, setAvailability] = useState<{ handle: string; free: boolean } | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const candidate = check.valid ? check.normalized : ''

  // A returning user lands here with the input prefilled from their own,
  // already-claimed handle (useClerkUserSync hydrates state.handle from
  // /v1/users/me). The availability check then correctly reports it taken --
  // a row does hold it, theirs -- which must not read as an error with no way
  // forward. Re-submitting is a genuine no-op: PUT /v1/users/me/handle is
  // idempotent for the same handle.
  const isOwnHandle = check.valid && state.handle !== null && candidate === state.handle

  // Claiming is the end of the flow: sign in, verify at least one card, then
  // pick a handle. Deep links that skip a step land on the step they skipped,
  // so a public profile never exists with nothing verified behind it.
  const signedIn = state.user !== null
  const confirmed = chosenCards.some((card) => state.vstatus[card.id] === 'verified')
  useEffect(() => {
    if (!signedIn) navigate({ kind: 'login' })
    else if (!confirmed) navigate({ kind: 'verify' })
  }, [signedIn, confirmed])

  useEffect(() => {
    if (candidate === '') return

    const controller = new AbortController()
    // Same shape as useWalletScore: debounce, and abort the in-flight request
    // on cleanup so a fast typist does not queue a dozen answers.
    const timer = setTimeout(() => {
      checkHandleAvailability(candidate, controller.signal)
        .then((free) => setAvailability({ handle: candidate, free }))
        .catch(() => {
          /* Offline or aborted. The claim itself is the real check. */
        })
    }, 250)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [candidate])

  if (!signedIn || !confirmed) return null

  const answered = availability?.handle === candidate ? availability : null
  const free = isOwnHandle ? true : (answered?.free ?? false)
  const canClaim = check.valid && free && !claiming

  const message = error
    ? error
    : !check.valid
      ? check.message
      : isOwnHandle
        ? 'This is your handle.'
        : answered === null
          ? 'Checking…'
          : free
            ? 'Available'
            : 'Taken. Try adding a number or an underscore.'

  const good = check.valid && free && error === null
  const color =
    check.shape === 'empty'
      ? 'rgba(255,255,255,0.35)'
      : !check.valid || error
        ? '#F87171'
        : isOwnHandle
          ? '#34D399'
          : answered === null
            ? 'rgba(255,255,255,0.55)'
            : free
              ? '#34D399'
              : '#F87171'
  const borderColor =
    check.shape === 'empty'
      ? 'rgba(255,255,255,0.12)'
      : good
        ? 'rgba(52,211,153,0.5)'
        : 'rgba(248,113,113,0.5)'

  const submit = async () => {
    setClaiming(true)
    setError(null)
    try {
      const claimed = await claimHandle(check.normalized)
      dispatch(walletActions.claimHandle(claimed.handle ?? check.normalized))
      navigate({ kind: 'profile', username: claimed.handle ?? check.normalized })
    } catch (err) {
      // A 409 between the availability check and here is the whole reason this
      // renders in place rather than navigating optimistically.
      setError(
        err instanceof ApiError
          ? (err.details?.[0] ?? err.message)
          : 'Could not claim that handle.',
      )
      setAvailability({ handle: candidate, free: false })
    } finally {
      setClaiming(false)
    }
  }

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <h2 className={styles.title}>Pick your handle</h2>
      <p className={styles.blurb}>This becomes your public profile address.</p>

      <div className={styles.panel}>
        <div className={styles.label}>Your URL</div>
        <div className={styles.url}>
          <span className={styles.domain}>{PROFILE_PREFIX}</span>
          <span style={{ color }}>{check.normalized || 'yourname'}</span>
        </div>

        <div className={styles.field} style={{ borderColor }}>
          <input
            className={styles.input}
            value={handle}
            onChange={(e) => {
              setHandle(e.target.value)
              setError(null)
            }}
            disabled={claiming}
            placeholder="yourname"
            aria-label="Your handle"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={HANDLE_MAX}
          />
          <span className={styles.icon} style={{ color }} aria-hidden="true">
            {check.shape === 'empty' || (check.valid && answered === null && !isOwnHandle)
              ? ''
              : good
                ? '✓'
                : '✕'}
          </span>
        </div>
        <div className={styles.message} style={{ color }} role="status">
          {message}
        </div>
      </div>

      <div className={styles.footer}>
        <Button disabled={!canClaim} onClick={submit}>
          {claiming ? 'Claiming…' : 'Claim handle'}
        </Button>
        <div className={styles.footnote}>
          Letters, numbers and underscores. {HANDLE_MIN}–{HANDLE_MAX} characters.
        </div>
      </div>
    </Screen>
  )
}
