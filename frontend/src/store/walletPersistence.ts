import { isCardId } from '../data/cards'
import type { WalletState } from '../state/walletTypes'

export const STORAGE_KEY = 'ratemycards.wallet.v2'

export const initialWalletState: WalletState = {
  picked: [],
  vstatus: {},
  user: null,
  handle: null,
  verifiedAt: {},
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
