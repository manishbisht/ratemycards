import styles from './ConfirmRemove.module.css'

/**
 * The "are you sure" behind taking a verified card out of the wallet, as a
 * panel that sits under the row it is asking about rather than a dialog over
 * the screen.
 *
 * Inline for two reasons. The row stays visible, so a question about "this
 * card" is never asked with the card hidden behind it -- and CardRow renders
 * the whole row as one <button>, which nothing can be nested inside anyway, so
 * on the picker this has to be a sibling regardless.
 *
 * Only a verified card ever asks. An unverified one costs a tap to put back,
 * and gating the picker on every removal would put a two-step confirm in front
 * of a screen built to be tapped through quickly.
 *
 * The second line is worth saying rather than assumed: 'remove' reads like
 * 'lose the rupee you paid', and it is not. The verification lives in
 * card_verifications and outlives the wallet row, so the card comes back proved
 * (see the backend's stored-wallet notes).
 */
export function ConfirmRemove({
  name,
  className,
  onConfirm,
  onCancel,
}: {
  name: string
  className?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      className={[styles.panel, className].filter(Boolean).join(' ')}
      role="group"
      aria-label={`Remove ${name} from your wallet`}
    >
      <div className={styles.question}>Remove {name} from your wallet?</div>
      <p className={styles.detail}>
        It stops counting towards your rating. Your ₹1 verification is kept — adding the card
        back later will not ask for it again.
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.confirm} onClick={onConfirm}>
          Remove
        </button>
        <button type="button" className={styles.cancel} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
