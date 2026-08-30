import styles from './TierPill.module.css'

export function TierPill({ name, color, size = 'md' }: { name: string; color: string; size?: 'md' | 'sm' }) {
  return (
    <span
      className={size === 'sm' ? `${styles.pill} ${styles.sm}` : styles.pill}
      style={{
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 38%, transparent)`,
      }}
    >
      {name}
    </span>
  )
}
