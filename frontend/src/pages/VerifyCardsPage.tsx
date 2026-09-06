import { useCallback, useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { CardArt } from '../components/CardArt'
import { ConfirmRemove } from '../components/ConfirmRemove'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { confirmVerification, startVerification } from '../data/api'
import type { Card, CardId } from '../data/cards'
import { loadCheckout, openCheckout } from '../data/razorpayCheckout'
import { verifyLine } from '../data/scoring'
import { BLOCKED_NOTE, STATUS_COLOR, STATUS_LABEL, verifyNote } from '../data/verification'
import { navigate } from '../router/hashRouter'
import { useWalletScore } from '../state/useWalletScore'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { selectChosenCards, selectVerifiedCards, selectWallet } from '../store/selectors'
import { walletActions } from '../store/walletSlice'
import styles from './VerifyCardsPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(56,189,248,0.26)', size: 440, top: -170, left: -130 },
  { color: 'rgba(88,28,135,0.6)', size: 460, bottom: -170, right: -140 },
]

/**
 * Where a row sits, lowest first -- by what it asks of the person reading it.
 *
 * A card waiting to be proved is the whole point of the screen, so it leads. A
 * proved one is finished business: still here, still removable, but it has no
 * claim on the top. One nothing can verify goes last, because no tap on this
 * screen can move it forward -- see `unverifiable` below.
 *
 * The picker ranks its own list on the same idea but not the same order (see
 * CardPickerPage's RANK), because it is also offering cards nobody holds. This
 * list only ever holds the wallet.
 */
const ROW_RANK = { toVerify: 0, verified: 1, blocked: 2 }

/** Drops one card's entry from a per-card map, leaving the rest alone. */
function forget<T>(source: Record<CardId, T>, id: CardId): Record<CardId, T> {
  if (!(id in source)) return source

  const next: Record<CardId, T> = {}
  for (const key of Object.keys(source)) {
    if (key !== id) next[key] = source[key]
  }
  return next
}

export function VerifyCardsPage() {
  const [openNote, setOpenNote] = useState<CardId | null>(null)
  /** Per-card message from the last attempt: why it failed, or what matched. */
  const [outcome, setOutcome] = useState<Record<CardId, string>>({})
  /**
   * Cards with a modal open right now, in this tab.
   *
   * The button locks on this rather than on the server's 'pending', because
   * 'pending' outlives the attempt: a tab closed mid-payment leaves it set with
   * nothing coming to clear it, and keying the disable off it would strand the
   * card on "Waiting…" with no way to retry.
   */
  const [busy, setBusy] = useState<Record<CardId, boolean>>({})
  /**
   * The card whose removal is being confirmed, if any.
   *
   * One at a time: opening a second question closes the first, so there is
   * never more than one destructive choice on screen to mis-tap.
   */
  const [confirming, setConfirming] = useState<CardId | null>(null)
  const dispatch = useAppDispatch()
  const wallet = useAppSelector(selectWallet)
  const chosenCards = useAppSelector(selectChosenCards)
  const verifiedCards = useAppSelector(selectVerifiedCards)
  // Held cards with no BIN prefixes on file: nothing here can verify them, so
  // they must not hold the summary short of "all verified".
  const blockedCount = chosenCards.filter((card) => !card.selectable).length
  const statusOf = (id: CardId) => wallet.vstatus[id] ?? 'unverified'
  const verifiedDateOf = (id: CardId) => wallet.verifiedAt[id]

  /**
   * The wallet, grouped by ROW_RANK. Sorting a copy, and a stable sort, so the
   * order the cards were added survives inside each group.
   */
  const rows = useMemo(() => {
    const rankOf = (card: Card): number => {
      // Asked first, and without consulting the wallet: a card with no BIN
      // prefixes on file cannot be proved by anybody, whatever this wallet
      // believes about it.
      if (!card.selectable) return ROW_RANK.blocked
      return (wallet.vstatus[card.id] ?? 'unverified') === 'verified'
        ? ROW_RANK.verified
        : ROW_RANK.toVerify
    }

    return chosenCards
      .map((card) => ({ card, rank: rankOf(card) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ card }) => card)
  }, [chosenCards, wallet.vstatus])

  /**
   * The real verification: mint an order, open Checkout narrowed to this card's
   * BINs, then hand the callback to the server to decide.
   *
   * Optimistically marks the row 'pending' so the button locks while the modal
   * is up, and rolls back to 'failed' on anything short of success -- a
   * dismissed modal included, otherwise the row would sit on 'Waiting…' with
   * nothing coming.
   */
  const verify = useCallback(
    async (cardId: CardId) => {
      if (busy[cardId]) return
      setBusy((current) => ({ ...current, [cardId]: true }))
      setOutcome((current) => ({ ...current, [cardId]: '' }))
      dispatch(walletActions.startVerification(cardId))

      const fail = (message: string) => {
        dispatch(walletActions.setVerificationStatus({ id: cardId, status: 'failed' }))
        setOutcome((current) => ({ ...current, [cardId]: message }))
      }

      try {
        const [order, Razorpay] = await Promise.all([startVerification(cardId), loadCheckout()])

        const result = await openCheckout(Razorpay, {
          keyId: order.keyId,
          orderId: order.orderId,
          amount: order.amount,
          currency: order.currency,
          cardName: order.cardName,
          issuer: order.issuer,
          iins: order.allowed.iins,
          prefill: wallet.user
            ? { name: wallet.user.name, email: wallet.user.email }
            : undefined,
        })

        if (result.kind === 'dismissed') {
          fail('Verification cancelled. The ₹1 authorisation was never taken.')
          return
        }
        if (result.kind === 'failed') {
          fail(result.reason)
          return
        }

        const confirmed = await confirmVerification(order.verificationId, result.payload)

        dispatch(
          walletActions.setVerificationStatus({
            id: cardId,
            status: 'verified',
            at: new Date().toISOString(),
          }),
        )
        setOutcome((current) => ({
          ...current,
          [cardId]: `Matched a ${confirmed.card.network} card ending ${confirmed.card.last4}. ${
            confirmed.releaseState === 'refunded'
              ? 'The ₹1 has been refunded.'
              : 'The ₹1 was never captured and will be released by your bank.'
          }`,
        }))
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Verification failed. Please try again.')
      } finally {
        setBusy((current) => ({ ...current, [cardId]: false }))
      }
    },
    [busy, dispatch, wallet.user],
  )

  /**
   * Takes a card out of the wallet and forgets what this screen was holding
   * about it.
   *
   * The second half matters because the wallet is not the only place a card
   * leaves a trace: an outcome message from a failed attempt, or a note left
   * open, is keyed by card id and would still be sitting there if the card were
   * added back from the picker. The store's own removal is the same
   * `toggleCard` the picker uses, so it takes the one path that writes through
   * to the server.
   */
  const removeFromWallet = useCallback(
    (cardId: CardId) => {
      setConfirming(null)
      setOpenNote(null)
      setOutcome((current) => forget(current, cardId))
      setBusy((current) => forget(current, cardId))
      dispatch(walletActions.toggleCard(cardId))
    },
    [dispatch],
  )

  const chosenCount = chosenCards.length
  const verifiedCount = verifiedCards.length

  // Past the Reveal gate, so this screen may show the running rating.
  const { score } = useWalletScore(verifiedCards.map((card) => card.id))
  const { score: rating, tier } = score

  // Verification is the last step before claiming a handle. One confirmed card
  // is enough to move on — the rest stay private and unscored.
  const canClaim = verifiedCount > 0

  // This is where sign-in lands, every time (ssoRedirect.ts, LoginPage.tsx),
  // so a returning user who already claimed a handle must see a CTA that
  // takes them to their profile rather than back through Claim -- see
  // RatingRevealPage's identical guard.
  const handle = wallet.handle
  const claimed = handle !== null

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <h2 className={styles.title}>Verify your cards</h2>
      <p className={styles.blurb}>
        A ₹1 authorisation, refunded instantly, confirms the card is yours. Only verified cards
        count towards your rating.
      </p>

      <div className={styles.rows}>
        {rows.length === 0 ? (
          <div className={styles.empty}>
            No cards yet. Add a few from your wallet and they will show up here to verify.
          </div>
        ) : (
          rows.map((card) => {
            const status = statusOf(card.id)
            const isVerified = status === 'verified'
            // In flight in this tab. A stale server-side 'pending' still shows
            // its label, but must not lock the button.
            const isPending = busy[card.id] === true
            const isFailed = status === 'failed'
            /**
             * No BIN prefixes on file, so `POST /v1/verifications` would refuse
             * this outright. The catalog already carries `selectable`, so the
             * dead end is knowable before the tap rather than after it -- and
             * the row can offer the one thing that actually helps instead.
             */
            const unverifiable = !card.selectable

            const rowBorder = isVerified
              ? 'rgba(52,211,153,0.28)'
              : isFailed
                ? 'rgba(248,113,113,0.28)'
                : 'var(--hairline)'

            return (
              <div key={card.id} className={styles.row} style={{ borderColor: rowBorder }}>
                <div className={styles.rowMain}>
                  <CardArt issuer={card.issuer} />
                  <div className={styles.rowText}>
                    <div className={styles.rowName}>{card.name}</div>
                    <div
                      className={styles.rowStatus}
                      style={{ color: unverifiable ? 'var(--text-muted)' : STATUS_COLOR[status] }}
                    >
                      {unverifiable ? 'Can’t verify' : STATUS_LABEL[status]}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.action}
                    disabled={isPending}
                    style={{
                      background: isVerified
                        ? 'rgba(52,211,153,0.12)'
                        : isPending || unverifiable
                          ? 'transparent'
                          : '#fff',
                      color: isVerified
                        ? 'var(--status-verified)'
                        : isPending || unverifiable
                          ? 'rgba(255,255,255,0.6)'
                          : 'var(--bg)',
                      borderColor: isVerified
                        ? 'rgba(52,211,153,0.35)'
                        : isPending || unverifiable
                          ? 'rgba(255,255,255,0.16)'
                          : 'transparent',
                    }}
                    onClick={() => {
                      // Both of these open the row's note instead of acting:
                      // one has nothing left to do, the other has nothing this
                      // screen can do. What each offers lives in the note.
                      if (unverifiable || isVerified) {
                        setConfirming(null)
                        setOpenNote((current) => (current === card.id ? null : card.id))
                        return
                      }
                      setOpenNote(card.id)
                      void verify(card.id)
                    }}
                  >
                    {unverifiable
                      ? 'Options'
                      : isVerified
                        ? 'Verified'
                        : isPending
                          ? 'Waiting…'
                          : isFailed || status === 'pending'
                            ? 'Retry'
                            : 'Verify'}
                  </button>
                </div>

                {confirming === card.id ? (
                  <ConfirmRemove
                    name={card.name}
                    className={styles.confirm}
                    onConfirm={() => removeFromWallet(card.id)}
                    onCancel={() => setConfirming(null)}
                  />
                ) : openNote === card.id && (unverifiable || status !== 'unverified') ? (
                  <div className={styles.note}>
                    {unverifiable
                      ? BLOCKED_NOTE
                      : outcome[card.id] || verifyNote(status, verifiedDateOf(card.id))}
                    {unverifiable ? (
                      <>
                        <button
                          type="button"
                          className={styles.noteLink}
                          onClick={() => navigate({ kind: 'requests', cardId: card.id })}
                        >
                          Tell us its first 6 digits
                        </button>
                        {/* Straight out, with no "are you sure" in front of it.
                            ConfirmRemove exists to say the ₹1 is not lost, and
                            this card has never been asked for one -- putting it
                            here would answer a question nobody asked. Adding it
                            back is one tap in the picker, which lists cards
                            nothing can verify for exactly this reason. */}
                        <button
                          type="button"
                          className={styles.remove}
                          onClick={() => removeFromWallet(card.id)}
                        >
                          Remove from wallet
                        </button>
                      </>
                    ) : isVerified ? (
                      <button
                        type="button"
                        className={styles.remove}
                        onClick={() => setConfirming(card.id)}
                      >
                        Remove from wallet
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <div className={styles.footer}>
        <div className={styles.summary}>
          <div className={styles.summaryLine}>
            {verifyLine(chosenCount, verifiedCount, blockedCount)}
          </div>
          <div
            className={styles.summaryScore}
            style={{ color: verifiedCount ? tier.color : 'rgba(255,255,255,0.35)' }}
          >
            {rating}
          </div>
        </div>
        <Button
          disabled={!claimed && !canClaim}
          onClick={() =>
            navigate(claimed ? { kind: 'profile', username: handle } : { kind: 'claim' })
          }
        >
          {claimed ? 'View your profile' : canClaim ? 'Claim your handle' : 'Verify a card to continue'}
        </Button>
        <div className={styles.footnote}>Unverified cards stay private and are never scored.</div>
      </div>
    </Screen>
  )
}
