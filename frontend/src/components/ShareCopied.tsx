import { useEffect, useRef } from 'react'
import styles from './ShareCopied.module.css'

/**
 * What happened to the clipboard, said before the share target opens.
 *
 * This used to be a line of text under the buttons, which nobody ever read: the
 * share tab opened in the same breath and took the screen with it. The message
 * only lands if it arrives BEFORE the redirect, so the redirect became a button
 * on this dialog instead of something that happens to you.
 *
 * That the continue button is a second, separate tap is a bonus rather than a
 * cost. `window.open` off the back of it carries its own user gesture, so there
 * is no popup blocker to argue with and no activation window to beat.
 */
export function ShareCopied({
  where,
  copied,
  onContinue,
  onClose,
}: {
  /** Where they are about to be sent, named so the button can say it. */
  where: string
  /** False when the browser refused the image; the link still works. */
  copied: boolean
  onContinue: () => void
  onClose: () => void
}) {
  const primary = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    primary.current?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-copied-title"
        /* The backdrop closes; the panel is not the backdrop. */
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.mark} aria-hidden="true">
          {copied ? '✓' : '!'}
        </div>

        <h2 className={styles.title} id="share-copied-title">
          {copied ? 'Image copied' : 'Could not copy the image'}
        </h2>

        <p className={styles.body}>
          {copied
            ? 'Your share card is on the clipboard. Paste it into the post when you get there — your link goes along with it.'
            : 'This browser would not take the image. Your link still works, so the post will go out without it.'}
        </p>

        <button ref={primary} type="button" className={styles.continue} onClick={onContinue}>
          Continue to {where}
        </button>
        <button type="button" className={styles.cancel} onClick={onClose}>
          Not now
        </button>
      </div>
    </div>
  )
}
