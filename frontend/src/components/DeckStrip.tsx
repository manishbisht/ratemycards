import type { Card } from '../data/cards'
import { cardArtSrc } from '../data/cardArt'
import { STATUS_COLOR } from '../data/verification'
import type { VerificationStatus } from '../state/walletTypes'
import styles from './DeckStrip.module.css'

const DOT: Record<VerificationStatus, string> = {
  verified: '✓',
  pending: '·',
  unverified: '!',
  failed: '!',
}

/**
 * The overlapping deck on the picker. Unverified tiles are dashed and dimmed,
 * with the status dot pinned to the sliver of tile that stays exposed.
 */
export function DeckStrip({
  cards,
  statusOf,
  showStatus = true,
}: {
  cards: Card[]
  statusOf: (id: string) => VerificationStatus
  /** Off before sign-in, when no card has had the chance to be verified yet. */
  showStatus?: boolean
}) {
  return (
    <div className={styles.strip}>
      {cards.slice(-4).map((card) => {
        const status = statusOf(card.id)
        const verified = !showStatus || status === 'verified'
        return (
          <div
            key={card.id}
            className={styles.tile}
            style={{
              borderStyle: verified ? 'solid' : 'dashed',
              borderColor: verified ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.22)',
              opacity: verified ? 1 : 0.55,
            }}
          >
            <img className={styles.art} src={cardArtSrc(card.issuer, card.name)} alt="" aria-hidden="true" />
            {showStatus ? (
            <span
              className={styles.dot}
              style={{
                background: verified ? 'rgba(52,211,153,0.16)' : 'rgba(10,10,15,0.4)',
                borderColor: verified ? 'rgba(52,211,153,0.45)' : 'rgba(255,255,255,0.2)',
                color: STATUS_COLOR[status],
              }}
            >
              {DOT[status]}
            </span>
            ) : null}
            <span className={styles.label}>{card.short}</span>
          </div>
        )
      })}
    </div>
  )
}
