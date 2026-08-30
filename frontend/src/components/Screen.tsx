import type { CSSProperties, ReactNode } from 'react'
import styles from './Screen.module.css'

export type GlowSpec = {
  color: string
  size: number
  top?: number
  bottom?: number
  left?: number
  right?: number
}

/**
 * A full-viewport screen with the design's decorative radial glows behind it.
 * The design draws these inside a fixed 390x844 phone frame; here the frame is
 * the viewport, so the glows keep their pixel offsets and are clipped by it.
 */
export function Screen({
  glows = [],
  className,
  style,
  children,
}: {
  glows?: GlowSpec[]
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <div className={styles.screen} style={style}>
      {glows.map((glow, i) => (
        <div
          key={i}
          className={styles.glow}
          style={{
            width: glow.size,
            height: glow.size,
            top: glow.top,
            bottom: glow.bottom,
            left: glow.left,
            right: glow.right,
            background: `radial-gradient(circle at 50% 50%, ${glow.color} 0%, transparent 70%)`,
          }}
        />
      ))}
      <div className={className ? `${styles.content} ${className}` : styles.content}>
        {children}
      </div>
    </div>
  )
}
