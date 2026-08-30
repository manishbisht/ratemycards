import { useState } from 'react'
import { Button } from '../components/Button'
import { CardArt } from '../components/CardArt'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import type { CardId } from '../data/cards'
import { verifyLine } from '../data/scoring'
import { STATUS_COLOR, STATUS_LABEL, verifyNote } from '../data/verification'
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

export function VerifyCardsPage() {
  const [openNote, setOpenNote] = useState<CardId | null>(null)
  const dispatch = useAppDispatch()
  const wallet = useAppSelector(selectWallet)
  const chosenCards = useAppSelector(selectChosenCards)
  const verifiedCards = useAppSelector(selectVerifiedCards)
  const statusOf = (id: CardId) => wallet.vstatus[id] ?? 'unverified'
  const verifiedDateOf = (id: CardId) => wallet.verifiedAt[id]

  const chosenCount = chosenCards.length
  const verifiedCount = verifiedCards.length

  // Past the Reveal gate, so this screen may show the running rating.
  const { score } = useWalletScore(verifiedCards.map((card) => card.id))
  const { score: rating, tier } = score

  // Verification is the last step before claiming a handle. One confirmed card
  // is enough to move on — the rest stay private and unscored.
  const canClaim = verifiedCount > 0

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <h2 className={styles.title}>Verify your cards</h2>
      <p className={styles.blurb}>
        A ₹1 authorisation, refunded instantly, confirms the card is yours. Only verified cards
        count towards your rating.
      </p>

      <div className={styles.rows}>
        {chosenCards.length === 0 ? (
          <div className={styles.empty}>
            No cards yet. Add a few from your wallet and they will show up here to verify.
          </div>
        ) : (
          chosenCards.map((card) => {
            const status = statusOf(card.id)
            const isVerified = status === 'verified'
            const isPending = status === 'pending'
            const isFailed = status === 'failed'

            const rowBorder = isVerified
              ? 'rgba(52,211,153,0.28)'
              : isFailed
                ? 'rgba(248,113,113,0.28)'
                : 'var(--hairline)'

            return (
              <div key={card.id} className={styles.row} style={{ borderColor: rowBorder }}>
                <div className={styles.rowMain}>
                  <CardArt issuer={card.issuer} name={card.name} />
                  <div className={styles.rowText}>
                    <div className={styles.rowName}>{card.name}</div>
                    <div className={styles.rowStatus} style={{ color: STATUS_COLOR[status] }}>
                      {STATUS_LABEL[status]}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.action}
                    disabled={isPending}
                    style={{
                      background: isVerified
                        ? 'rgba(52,211,153,0.12)'
                        : isPending
                          ? 'transparent'
                          : '#fff',
                      color: isVerified
                        ? 'var(--status-verified)'
                        : isPending
                          ? 'rgba(255,255,255,0.6)'
                          : 'var(--bg)',
                      borderColor: isVerified
                        ? 'rgba(52,211,153,0.35)'
                        : isPending
                          ? 'rgba(255,255,255,0.16)'
                          : 'transparent',
                    }}
                    onClick={() => {
                      if (isVerified) {
                        setOpenNote((current) => (current === card.id ? null : card.id))
                        return
                      }
                      setOpenNote(card.id)
                      dispatch(walletActions.startVerification(card.id))
                    }}
                  >
                    {isVerified ? 'Verified' : isPending ? 'Waiting…' : isFailed ? 'Retry' : 'Verify'}
                  </button>
                </div>

                {openNote === card.id && status !== 'unverified' ? (
                  <div className={styles.note}>{verifyNote(status, verifiedDateOf(card.id))}</div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <div className={styles.footer}>
        <div className={styles.summary}>
          <div className={styles.summaryLine}>{verifyLine(chosenCount, verifiedCount)}</div>
          <div
            className={styles.summaryScore}
            style={{ color: verifiedCount ? tier.color : 'rgba(255,255,255,0.35)' }}
          >
            {rating}
          </div>
        </div>
        <Button disabled={!canClaim} onClick={() => navigate({ kind: 'claim' })}>
          {canClaim ? 'Claim your handle' : 'Verify a card to continue'}
        </Button>
        <div className={styles.footnote}>Unverified cards stay private and are never scored.</div>
      </div>
    </Screen>
  )
}
