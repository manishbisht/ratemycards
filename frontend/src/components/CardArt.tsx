import styles from './CardArt.module.css'
import { cardArtSrc } from '../data/cardArt'

/** The small card swatch that leads every list row. */
export function CardArt({ issuer }: { issuer: string }) {
  return <img className={styles.art} src={cardArtSrc(issuer)} alt="" aria-hidden="true" />
}
