import styles from './CardArt.module.css'
import { cardArtSrc } from '../data/cardArt'

/** The small card swatch that leads every list row. */
export function CardArt({ issuer, name }: { issuer: string; name: string }) {
  return <img className={styles.art} src={cardArtSrc(issuer, name)} alt="" aria-hidden="true" />
}
