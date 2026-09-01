import type { ChangeEvent, ReactNode } from 'react'
import styles from './AdminUi.module.css'

/**
 * The console's small parts. Kept together in one module because each is a
 * dozen lines and they are only ever used side by side -- the app's own
 * components live one-per-file because they are used one at a time.
 */

/* ------------------------------------------------------------------ inputs */

type FieldProps = {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'number'
  maxLength?: number
  disabled?: boolean
  /** Shown under the input, in the muted colour. */
  hint?: string
}

export function Field({ label, value, onChange, hint, type = 'text', ...rest }: FieldProps) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        className={styles.input}
        type={type}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        {...rest}
      />
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
    </label>
  )
}

type SelectProps = {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}

export function Select({ label, value, onChange, options, disabled }: SelectProps) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <select
        className={styles.input}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={styles.toggle}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

/* ------------------------------------------------------------------ chrome */

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
}: {
  children: ReactNode
  onClick: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`${styles.button} ${styles[variant]}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'good' | 'bad' | 'warn'
}) {
  return <span className={`${styles.pill} ${styles[tone]}`}>{children}</span>
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={styles.panel}>
      <header className={styles.panelHead}>
        <div>
          <h2 className={styles.panelTitle}>{title}</h2>
          {subtitle ? <p className={styles.panelSubtitle}>{subtitle}</p> : null}
        </div>
        {actions ? <div className={styles.panelActions}>{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------ status */

/**
 * An API failure, with the per-field detail the backend's accumulator-style
 * validators produce. `message` alone is only ever "The request body is
 * invalid.", which tells an admin nothing about which BIN it disliked.
 */
export function ErrorNote({ message, details }: { message: string; details?: string[] }) {
  return (
    <div className={styles.error} role="alert">
      <strong>{message}</strong>
      {details && details.length > 0 ? (
        <ul className={styles.errorList}>
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>
}
