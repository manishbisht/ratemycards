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
 * The pile of chosen cards on the picker. A tile is the card's own artwork at
 * the 1.6 it is drawn at and nothing else: the art already prints the card
 * name, so a label over it would only land on top of that. The name reaches
 * screen readers through the image's alt text instead.
 *
 * The first card sits on top and whole; every card after it steps to the right
 * and *behind*, so what shows of it is the right-hand edge. That is the only
 * arrangement where one card is fully readable -- stacking front-to-back the
 * other way leaves every card but the last cut off mid-name.
 *
 * Unverified tiles are dashed and dimmed, with the status dot pinned to the
 * edge of the tile that stays exposed.
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
  const shown = cards.slice(-4)
  return (
    <div className={styles.strip}>
      {shown.map((card, i) => {
        const status = statusOf(card.id)
        const verified = !showStatus || status === 'verified'
        return (
          <div
            key={card.id}
            className={styles.tile}
            style={{
              borderStyle: verified ? 'solid' : 'dashed',
              borderColor: verified ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.22)',
              // Painted back-to-front against DOM order, so the first card
              // ends up on top of the pile rather than under all of them.
              zIndex: shown.length - i,
              // Receding into the pile, the way the fanned deck dims too.
              filter: `brightness(${(1 - i * 0.09).toFixed(2)})`,
            }}
          >
            <img
              className={styles.art}
              src={cardArtSrc(card.issuer, card.name)}
              alt={`${card.issuer} ${card.name}`}
              // An unverified card is dimmed on its artwork, never on the tile:
              // fading the tile itself would make it translucent, and the cards
              // stacked behind it would show through.
              style={{ opacity: verified ? 1 : 0.4 }}
            />
            {showStatus ? (
              <span
                className={styles.dot}
                style={{
                  background: verified ? 'rgba(52,211,153,0.16)' : 'rgba(10,10,15,0.4)',
                  borderColor: verified ? 'rgba(52,211,153,0.45)' : 'rgba(255,255,255,0.2)',
                  color: STATUS_COLOR[status],
                }}
                /* The rows above spell the same state out in words. */
                aria-hidden="true"
              >
                {DOT[status]}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
