import { isCardId } from '../data/cards'
import type { User, VerificationStatus, WalletState } from '../state/walletTypes'
import type { CardId } from '../data/cards'

/**
 * The cards this browser is holding on the server's behalf, and nothing else.
 *
 * Written only while there are picks the server has not taken, and removed the
 * moment it has them -- so on a signed-in browser this key does not exist. Any
 * `ratemycards.wallet.*` key found at startup that is not this one is swept for
 * the same reason: an older blob could name cards belonging to whoever last
 * used the browser, and sign-out clears the wallet precisely so one account's
 * cards cannot follow another's session.
 */
export const STORAGE_KEY = 'ratemycards.wallet.v3'

const WALLET_KEY_PREFIX = 'ratemycards.wallet.'

/**
 * Who is signed in, kept apart from the wallet because it outlives it.
 *
 * Both fields are wanted before the first paint and neither is wallet
 * contents: `user` tells a returning visitor from a new one while Clerk is
 * still booting (see useLandingDestination) and prefills the Razorpay form,
 * `handle` decides whether a profile is your own and prefills the claim
 * screen. Folding these into the wallet blob is what made "delete the wallet
 * once it is on the server" and "know who this is on the next load" look like
 * the same decision. They are not.
 */
export const SESSION_KEY = 'ratemycards.session.v1'

export const initialWalletState: WalletState = {
  picked: [],
  vstatus: {},
  user: null,
  handle: null,
  handleSynced: false,
  verifiedAt: {},
  synced: false,
}

function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null

    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Same reasoning as the write path: storage failures are not worth a crash.
  }
}

/** Sweeps wallet blobs from older layouts. Object.keys is already a snapshot. */
function sweepStaleWalletKeys(): void {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(WALLET_KEY_PREFIX) && key !== STORAGE_KEY) remove(key)
    }
  } catch {
    // Private mode can refuse enumeration. Nothing here is load-bearing.
  }
}

export function loadWalletState(): WalletState {
  sweepStaleWalletKeys()

  const session = readJson(SESSION_KEY)
  const wallet = readJson(STORAGE_KEY)

  return {
    ...initialWalletState,
    user: (session?.user as User | undefined) ?? null,
    handle: typeof session?.handle === 'string' ? session.handle : null,
    picked: Array.isArray(wallet?.picked) ? (wallet.picked as CardId[]).filter(isCardId) : [],
    vstatus: (wallet?.vstatus as Record<CardId, VerificationStatus> | undefined) ?? {},
    verifiedAt: (wallet?.verifiedAt as Record<CardId, string> | undefined) ?? {},
    // `synced` and `handleSynced` are deliberately absent: a reload starts a
    // fresh session that has not talked to the server yet, whatever the last
    // one managed to persist, and both default to false above.
  }
}

/**
 * Mirrors the two keys, each on its own condition.
 *
 * The wallet key exists exactly when there are picks the server has not taken.
 * It used to be written on every state change regardless, which meant
 * `replaceFromServer` mirrored the account's whole wallet straight back into
 * it, and three things followed:
 *
 *   - `synced` is never restored, so every page load merged again, sending the
 *     account its own cards back as if they were fresh anonymous work.
 *   - The blob outlived the hand-off it existed for, keeping a signed-in
 *     user's wallet on disk indefinitely.
 *   - Worst of the three: the merge is a union (`ON CONFLICT DO NOTHING`), so
 *     a card removed on another device was resurrected here at the next load
 *     by a mirror that had never heard about the removal.
 */
export function saveWalletState(state: WalletState): void {
  // Not merely emptied -- removed. An anonymous visitor who has picked nothing
  // yet leaves no trace, and a signed-in one leaves no wallet.
  if (state.synced || state.picked.length === 0) {
    remove(STORAGE_KEY)
  } else {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          picked: state.picked,
          vstatus: state.vstatus,
          verifiedAt: state.verifiedAt,
        }),
      )
    } catch {
      // Private-mode quota failures should never break the app.
    }
  }

  if (state.user === null && state.handle === null) {
    // Sign-out resets both, so this is how the session key goes away.
    remove(SESSION_KEY)
    return
  }

  try {
    window.localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ user: state.user, handle: state.handle }),
    )
  } catch {
    // As above.
  }
}
