import { Button } from '../components/Button'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { navigate } from '../router/hashRouter'
import styles from './NotFoundPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(124,58,237,0.45)', size: 460, top: -140, left: -140 },
  { color: 'rgba(30,27,75,0.85)', size: 480, bottom: -200, right: -140 },
]

export function NotFoundPage() {
  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.eyebrow}>ratemycards.in</div>
      <div className={styles.body}>
        <h2 className={styles.title}>Nothing here</h2>
        <p className={styles.blurb}>That link does not point anywhere in Rate My Cards.</p>
      </div>
      <div className={styles.footer}>
        <Button onClick={() => navigate({ kind: 'landing' })}>Go to the start</Button>
      </div>
    </Screen>
  )
}
