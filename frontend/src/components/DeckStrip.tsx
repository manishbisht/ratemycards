import type { Card } from '../data/cards'
import { cardArtSrc } from '../data/cardArt'
import { STATUS_COLOR } from '../data/verification'
import type { VerificationStatus } from '../state/walletTypes'
import styles from './DeckStrip.module.css'

/**
 * How many tiles fit, measured against the NARROWER of the two boxes this
 * renders in -- the profile's 346px, not the picker's 350px -- and against the
 * widest thing it can hold: a full pile plus the overflow badge.
 *
 * 136px for the front tile, six 26px steps, then the badge and its margin comes
 * to 320px. Eight tiles comes to 346px, which fits the profile exactly and
 * therefore does not fit it at all: a three-digit count or a narrower phone
 * clips. `--tile-step` cannot absorb the difference either, since 24px is its
 * floor before a buried card's status dot is cut off.
 */
const MAX_TILES = 7

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
 *
 * PROVED CARDS COME FIRST. The pile used to be the last four added, which meant
 * a wallet's best cards could be buried by whatever was tapped most recently.
 * Verified ones now lead and sit whole at the front, in the order the wallet
 * holds them.
 *
 * EVERYTHING ELSE IS NEWEST FIRST, which is the other half of that trade. Once
 * a wallet outgrows the pile, ordering the unproved cards oldest-first would
 * mean a card someone just tapped lands in the overflow count instead of on
 * screen -- so adding a card would look like nothing happened. Reversed, the
 * newest unproved card is always the first one after the proved ones.
 *
 * What still will not fit is counted rather than dropped: silently showing four
 * of eleven was the bug this replaced.
 */
export function DeckStrip({
  cards,
  statusOf,
  showStatus = true,
  className,
}: {
  cards: Card[]
  statusOf: (id: string) => VerificationStatus
  /** Off before sign-in, when no card has had the chance to be verified yet. */
  showStatus?: boolean
  /** Lets a screen place the pile; the profile centres it. */
  className?: string
}) {
  const verified = cards.filter((card) => statusOf(card.id) === 'verified')
  // Newest first. `picked` is append-ordered, so the card just tapped is last
  // -- and reversing is what puts it on top of the pile instead of behind
  // however many were added before it. Both `filter` calls return fresh arrays,
  // so `reverse` never touches the store's own.
  const rest = cards.filter((card) => statusOf(card.id) !== 'verified').reverse()

  const shown = [...verified, ...rest].slice(0, MAX_TILES)
  const hidden = cards.length - shown.length

  return (
    <div className={[styles.strip, className].filter(Boolean).join(' ')}>
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
              // Spread across however many are shown rather than a fixed step
              // per card, so the back of a full pile is dim and not black.
              filter: `brightness(${(1 - (shown.length < 2 ? 0 : i / (shown.length - 1)) * 0.34).toFixed(2)})`,
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

      {hidden > 0 ? (
        <span className={styles.more} aria-label={`${hidden} more`}>
          +{hidden}
        </span>
      ) : null}
    </div>
  )
}
