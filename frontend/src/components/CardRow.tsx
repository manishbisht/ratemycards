import { CardArt } from './CardArt'
import styles from './CardRow.module.css'

export function CardRow({
  name,
  issuer,
  status,
  statusColor,
  mark,
  onClick,
}: {
  name: string
  issuer: string
  status?: string
  statusColor?: string
  mark: string
  onClick: () => void
}) {
  const added = mark === '−'
  return (
    <button
      type="button"
      className={styles.row}
      onClick={onClick}
      aria-pressed={added}
      aria-label={`${added ? 'Remove' : 'Add'} ${name}`}
    >
      <CardArt issuer={issuer} name={name} />
      <span className={styles.text}>
        <span className={styles.name}>{name}</span>
        <span className={styles.issuer}>{issuer}</span>
      </span>
      {status ? (
        <span className={styles.status} style={{ color: statusColor }}>
          {status}
        </span>
      ) : null}
      <span className={styles.mark} aria-hidden="true">
        {mark}
      </span>
    </button>
  )
}
