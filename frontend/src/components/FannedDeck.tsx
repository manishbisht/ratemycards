import type { Card } from '../data/cards'
import { cardArtSrc } from '../data/cardArt'
import styles from './FannedDeck.module.css'

const lerp = (from: number, to: number, t: number) => from + (to - from) * t

/**
 * The fanned deck on the reveal and profile screens. Tiles brighten towards
 * the front of the stack; the design hand-tunes four steps, reproduced here as
 * an interpolation so any number of cards fans correctly.
 */
export function FannedDeck({
  cards,
  size = 'lg',
  className,
}: {
  cards: Card[]
  size?: 'lg' | 'sm'
  className?: string
}) {
  // Ascending by weight, so the strongest card sits at the front of the fan
  // the way the design stacks them.
  // Ratings are not published to the client, so there is nothing to rank by:
  // the last four added stand in for "your deck".
  const shown = cards.slice(-4)
  const deckClass = [styles.deck, size === 'sm' && styles.deckSm, className]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={deckClass}>
      {shown.map((card, i) => {
        const t = shown.length === 1 ? 1 : i / (shown.length - 1)
        const front = i === shown.length - 1
        return (
          <div
            key={card.id}
            className={size === 'lg' ? styles.tile : `${styles.tile} ${styles.tileSm}`}
            style={{
              // `backgroundImage`, not `background`: the shorthand would reset
              // the opaque base colour the stylesheet sets.
              backgroundImage: `linear-gradient(150deg, rgba(255,255,255,${lerp(0.13, 0.2, t).toFixed(3)}), rgba(255,255,255,${lerp(0.04, 0.08, t).toFixed(3)}))`,
              borderColor: `rgba(255,255,255,${lerp(0.14, 0.22, t).toFixed(3)})`,
            }}
          >
            <img className={styles.art} src={cardArtSrc(card.issuer, card.name)} alt="" aria-hidden="true" />
            <span
              className={styles.label}
              style={{
                color: front ? '#fff' : `rgba(255,255,255,${lerp(0.7, 0.88, t).toFixed(3)})`,
                fontWeight: front ? 600 : 500,
              }}
            >
              {card.short}
            </span>
          </div>
        )
      })}
    </div>
  )
}
