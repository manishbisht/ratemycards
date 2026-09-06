import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { DeckStrip } from '../components/DeckStrip'
import { Screen } from '../components/Screen'
import { ShareCopied } from '../components/ShareCopied'
import type { GlowSpec } from '../components/Screen'
import { TierPill } from '../components/TierPill'
import { fetchProfile } from '../data/api'
import type { PublicProfile, Tier } from '../data/api'
import { PUBLIC_DOMAIN, profileUrl } from '../data/brand'
import type { Card } from '../data/cards'
import { shareLine, summaryFor } from '../data/scoring'
import { renderShareImage } from '../data/shareImage'
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
  maxScore: number
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
  /**
   * The share waiting to be confirmed: where it is going, and whether the image
   * made it onto the clipboard. Null when no dialog is up.
   */
  const [pendingShare, setPendingShare] = useState<
    { url: string; where: string; copied: boolean } | null
  >(null)

  // Your own profile renders from local state, so it is instant and correct
  // while a claim is still settling. Anyone else's comes from the API.
  const own = state.handle === username

  // ...but only once that local state is worth anything. localStorage no longer
  // carries the cards past the sign-in hand-off, so a reload starts with an
  // empty wallet, and rendering it would put 0/3000 and a bare deck on the one
  // screen people share. Until the wallet lands, your own profile is read from
  // the public endpoint like anybody else's -- the same numbers, one request,
  // and no window where the page is blank or wrong.
  const ownReady = own && state.synced

  // One settled answer, tagged with the handle it belongs to. Derived rather
  // than reset at the top of the effect: this project's react-hooks config
  // rejects a synchronous setState in an effect body, and keying the result
  // means a late reply for a previous handle can never be shown against this
  // one.
  const [settled, setSettled] = useState<
    { handle: string; profile: PublicProfile } | { handle: string; profile: null } | null
  >(null)

  useEffect(() => {
    if (ownReady) return

    const controller = new AbortController()

    fetchProfile(username, controller.signal)
      .then((profile) => setSettled({ handle: username, profile }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setSettled({ handle: username, profile: null })
      })

    return () => controller.abort()
  }, [ownReady, username])

  const answer = settled?.handle === username ? settled : null
  const fetched = answer?.profile ?? null
  /**
   * Settled, and there is nothing there — as opposed to still loading.
   *
   * Never for your own handle. Now that the public read also backs your own
   * profile until the wallet lands, a 404 on it would otherwise offer you a
   * handle you are already holding, and it would win the race against the
   * wallet often enough to be seen.
   */
  const missing = answer !== null && answer.profile === null && !own

  const view: ProfileView | null = ownReady
    ? {
        handle: username,
        rating,
        maxScore: score.maxScore,
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
          maxScore: fetched.maxScore,
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
          // The handle decides this, not which endpoint the numbers came
          // from: your own profile is read publicly until the wallet lands,
          // and the footer must still offer to edit it rather than to rate a
          // wallet you already have.
          isOwn: own,
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
  const shareText = shareLine({
    isOwn: view.isOwn,
    handle: view.handle,
    rating: view.rating,
    maxScore: view.maxScore,
    tierName: tier.name,
    verifiedCount: view.verifiedCount,
  })

  /**
   * Copies the profile as an image, then asks before going anywhere.
   *
   * Every one of these intents can carry text and a link and none of them can
   * carry a picture, so the image travels the only way it can: on the clipboard,
   * ready to paste into the post.
   *
   * NOTHING IS OPENED HERE. An earlier version copied and redirected in one
   * breath, and the result was a message nobody could read -- the share tab took
   * the screen before the words landed. The redirect is a button on the dialog
   * now, which also means it carries its own user gesture and has no popup
   * blocker to argue with.
   *
   * The image is still finished and written while this document has focus,
   * because an unfocused document is refused the clipboard outright -- measured,
   * not guessed. That costs about 30ms once fonts and card art are warm.
   */
  const shareWith = async (target: string, where: string) => {
    // Declared without a value: both branches below set it, and an initialiser
    // nothing reads is the kind of dead assignment lint is right about.
    let copied: boolean

    try {
      const image = await renderShareImage({
        handle: view.handle,
        rating: view.rating,
        maxScore: view.maxScore,
        tier: { name: view.tier.name, color: view.tier.color },
        verifiedCount: view.verifiedCount,
        summary: view.summary,
        cards: view.cards.map((card) => ({ issuer: card.issuer, name: card.name })),
        domain: PUBLIC_DOMAIN,
        url,
      })

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })])
      copied = true
    } catch {
      // No clipboard, no ClipboardItem, or a browser that will not take a PNG.
      // The share still goes ahead; only the picture is lost, and the dialog
      // says so rather than pretending.
      copied = false
    }

    setPendingShare({ url: target, where, copied })
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

      {/* The picker's pile, not the fanned deck this screen used to draw.
          FannedDeck crops landscape card art into a portrait tile; DeckStrip
          keeps it at the 1.6 it was drawn at and names the front card over it.
          Every card on a profile is verified -- that is what the public
          projection returns -- so the status is a constant here. */}
      <DeckStrip
        cards={view.cards}
        statusOf={() => 'verified'}
        className={styles.deck}
      />

      <div className={styles.footer}>
        <Button
          variant="whatsapp"
          onClick={() =>
            void shareWith(
              `https://wa.me/?text=${encodeURIComponent(`${shareText} ${url}`)}`,
              'WhatsApp',
            )
          }
        >
          Share on WhatsApp
        </Button>
        <div className={styles.row}>
          <Button
            variant="secondary"
            onClick={() =>
              void shareWith(
                `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(url)}`,
                'X',
              )
            }
          >
            X
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void shareWith(
                `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
                'LinkedIn',
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

      {pendingShare ? (
        <ShareCopied
          where={pendingShare.where}
          copied={pendingShare.copied}
          onContinue={() => {
            window.open(pendingShare.url, '_blank', 'noopener,noreferrer')
            setPendingShare(null)
          }}
          onClose={() => setPendingShare(null)}
        />
      ) : null}
    </Screen>
  )
}
