import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { FannedDeck } from '../components/FannedDeck'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import { TierPill } from '../components/TierPill'
import { fetchProfile } from '../data/api'
import type { PublicProfile, Tier } from '../data/api'
import { PUBLIC_DOMAIN, profileUrl } from '../data/brand'
import type { Card } from '../data/cards'
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

export function ProfilePage({ username }: { username: string }) {
  const state = useAppSelector(selectWallet)
  const verifiedCards = useAppSelector(selectVerifiedCards)
  const { score } = useWalletScore(verifiedCards.map((card) => card.id))
  const rating = score.score
  const [copied, setCopied] = useState(false)

  // Your own profile renders from local state, so it is instant and correct
  // while a claim is still settling. Anyone else's comes from the API.
  const own = state.handle === username

  // One settled answer, tagged with the handle it belongs to. Derived rather
  // than reset at the top of the effect: this project's react-hooks config
  // rejects a synchronous setState in an effect body, and keying the result
  // means a late reply for a previous handle can never be shown against this
  // one.
  const [settled, setSettled] = useState<
    { handle: string; profile: PublicProfile } | { handle: string; profile: null } | null
  >(null)

  useEffect(() => {
    if (own) return

    const controller = new AbortController()

    fetchProfile(username, controller.signal)
      .then((profile) => setSettled({ handle: username, profile }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setSettled({ handle: username, profile: null })
      })

    return () => controller.abort()
  }, [own, username])

  const answer = settled?.handle === username ? settled : null
  const fetched = answer?.profile ?? null
  /** Settled, and there is nothing there — as opposed to still loading. */
  const missing = answer !== null && answer.profile === null

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
    : fetched
      ? {
          handle: fetched.handle,
          rating: fetched.score,
          tier: fetched.tier,
          verifiedCount: fetched.cardCount,
          summary: summaryFor(fetched.score, fetched.cardCount),
          // The public payload carries no fee or selectability, and the deck
          // does not render them.
          cards: fetched.cards.map((card) => ({
            id: card.id,
            name: card.name,
            issuer: card.issuer,
            short: `${card.bank.name}\n${card.name}`,
            joiningFee: 0,
            annualFee: 0,
            selectable: true,
          })),
          isOwn: false,
        }
      : null

  if (!view) {
    // A fetch still in flight is not a missing profile. Rendering the empty
    // screen here rather than the copy below is what stops "No wallet here
    // yet" flashing on every profile that does exist.
    if (!missing) return <Screen glows={GLOWS} className={styles.missing}>{null}</Screen>

    return (
      <Screen glows={GLOWS} className={styles.missing}>
        <div className={styles.eyebrow}>{PUBLIC_DOMAIN}</div>
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
  const url = profileUrl(view.handle)
  const shareText = `${view.handle} scored ${view.rating}/3000 on Rate My Cards.`

  const openShare = (target: string) => {
    window.open(target, '_blank', 'noopener,noreferrer')
  }

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.eyebrow}>{PUBLIC_DOMAIN}</div>

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
