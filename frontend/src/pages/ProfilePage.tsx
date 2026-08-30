import { useState } from 'react'
import { Button } from '../components/Button'
import { FannedDeck } from '../components/FannedDeck'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { TierPill } from '../components/TierPill'
import type { Tier } from '../data/api'
import type { Card } from '../data/cards'
import { demoProfile } from '../data/demoProfile'
import { summaryFor } from '../data/scoring'
import { navigate } from '../router/hashRouter'
import { useWalletScore } from '../state/useWalletScore'
import { useAppSelector } from '../store/hooks'
import { selectVerifiedCards, selectWallet } from '../store/selectors'
import styles from './ProfilePage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(251,146,60,0.22)', size: 440, top: -160, right: -120 },
  { color: 'rgba(124,58,237,0.45)', size: 460, top: 280, left: -180 },
  { color: 'rgba(30,27,75,0.85)', size: 480, bottom: -200, right: -140 },
]

type ProfileView = {
  handle: string
  rating: number
  tier: Tier
  verifiedCount: number
  summary: string
  cards: Card[]
  isOwn: boolean
}

function profileUrlFor(handle: string): string {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#u/${handle}`
}

export function ProfilePage({ username }: { username: string }) {
  const state = useAppSelector(selectWallet)
  const verifiedCards = useAppSelector(selectVerifiedCards)
  const { score } = useWalletScore(verifiedCards.map((card) => card.id))
  const rating = score.score
  const [copied, setCopied] = useState(false)

  const own = state.handle === username
  const demo = demoProfile(username)

  const view: ProfileView | null = own
    ? {
        handle: username,
        rating,
        tier: score.tier,
        verifiedCount: verifiedCards.length,
        summary: summaryFor(rating, verifiedCards.length),
        cards: verifiedCards,
        isOwn: true,
      }
    : demo
      ? { ...demo, isOwn: false }
      : null

  if (!view) {
    return (
      <Screen glows={GLOWS} className={styles.missing}>
        <div className={styles.eyebrow}>ratemycards.in</div>
        <div className={styles.missingBody}>
          <h2 className={styles.missingTitle}>No wallet here yet</h2>
          <p className={styles.missingBlurb}>
            Nobody has claimed <span className={styles.missingHandle}>{username}</span>. It could be
            yours.
          </p>
        </div>
        <div className={styles.footer}>
          <Button onClick={() => navigate({ kind: 'landing' })}>Rate your own wallet</Button>
        </div>
      </Screen>
    )
  }

  const tier = view.tier
  const url = profileUrlFor(view.handle)
  const shareText = `${view.handle} scored ${view.rating}/3000 on Rate My Cards.`

  const openShare = (target: string) => {
    window.open(target, '_blank', 'noopener,noreferrer')
  }

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.eyebrow}>ratemycards.in</div>

      <div className={styles.panel}>
        <div className={styles.handle} style={{ color: tier.color }}>
          {view.handle}
        </div>
        <div className={styles.score} style={{ color: tier.color }}>
          {view.rating}
        </div>
        <div className={styles.pills}>
          <TierPill name={tier.name} color={tier.color} size="sm" />
          <span className={styles.verifiedPill}>✓ {view.verifiedCount} verified</span>
        </div>
        <p className={styles.summary}>{view.summary}</p>
      </div>

      <FannedDeck cards={view.cards} size="sm" className={styles.deck} />

      <div className={styles.footer}>
        <Button
          variant="whatsapp"
          onClick={() => openShare(`https://wa.me/?text=${encodeURIComponent(`${shareText} ${url}`)}`)}
        >
          Share on WhatsApp
        </Button>
        <div className={styles.row}>
          <Button
            variant="secondary"
            onClick={() =>
              openShare(
                `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(url)}`,
              )
            }
          >
            X
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              openShare(
                `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
              )
            }
          >
            LinkedIn
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              navigator.clipboard?.writeText(url).then(
                () => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                },
                () => setCopied(false),
              )
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
        <button
          type="button"
          className={styles.ownLink}
          onClick={() => navigate({ kind: view.isOwn ? 'wallet' : 'landing' })}
        >
          {view.isOwn ? 'Edit your wallet →' : 'Rate your own wallet →'}
        </button>
      </div>
    </Screen>
  )
}
