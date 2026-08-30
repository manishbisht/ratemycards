import { isCardId } from '../data/cards'
import type { WalletState } from '../state/walletTypes'

/**
 * Bumped from v2 when wallets became server-owned. A v2 blob could name cards
 * belonging to whoever last used this browser, and sign-out now clears the
 * wallet precisely so one account's cards cannot follow another's session --
 * reading the old key would reopen that.
 */
export const STORAGE_KEY = 'ratemycards.wallet.v3'

export const initialWalletState: WalletState = {
  picked: [],
  vstatus: {},
  user: null,
  handle: null,
  verifiedAt: {},
  synced: false,
}

export function loadWalletState(): WalletState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialWalletState

    const parsed = JSON.parse(raw)
    return {
      ...initialWalletState,
      ...parsed,
      picked: Array.isArray(parsed?.picked) ? parsed.picked.filter(isCardId) : [],
      vstatus: parsed?.vstatus ?? {},
      verifiedAt: parsed?.verifiedAt ?? {},
      // Never restored: a reload starts a fresh session that has not talked to
      // the server yet, whatever the last one managed to persist.
      synced: false,
    }
  } catch {
    return initialWalletState
  }
}

export function saveWalletState(state: WalletState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Private-mode quota failures should never break the app.
  }
}
