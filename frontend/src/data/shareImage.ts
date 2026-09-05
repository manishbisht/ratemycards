import { cardArtSrc } from './cardArt'

/**
 * Draws a profile as a square PNG, for pasting into a post.
 *
 * Hand-drawn on a canvas rather than rasterised from the DOM. html2canvas and
 * friends are ~200KB to reimplement a layout engine badly, and this app carries
 * five runtime dependencies in total; the card is a dozen shapes and six lines
 * of text, which is less code than the wiring for a library would be.
 *
 * It stays same-origin throughout -- card art is local SVG under /card-art --
 * so the canvas is never tainted and `toBlob` works.
 */

/** Square: the one ratio WhatsApp, X and LinkedIn all show uncropped. */
const SIZE = 1080

const BG = '#0a0a0f'
const MUTED = 'rgba(255,255,255,0.45)'
const FONT = "'Outfit', system-ui, -apple-system, sans-serif"

/** Matches DeckStrip's cap, so the image shows the pile the profile does. */
const MAX_TILES = 7

/** Tile geometry, at the 1.6 the card art is drawn at. Seven come to 750px. */
const TILE_W = 330
const TILE_H = Math.round(TILE_W / 1.6)
const TILE_STEP = 70

/**
 * The size the art is rasterised at before being scaled into a tile.
 *
 * Comfortably over TILE_W on purpose: an SVG in an `<img>` is rasterised at its
 * stated size and only then scaled, so stamping the source's own 320px would
 * hand the canvas a bitmap to blow up and soften.
 */
const ART_W = 720
const ART_H = 450

export type ShareCard = {
  handle: string
  rating: number
  maxScore: number
  tier: { name: string; color: string }
  verifiedCount: number
  summary: string
  cards: { issuer: string; name: string }[]
  /** The domain, drawn small at the top. */
  domain: string
  /** The full profile link, drawn at the foot so it travels with the image. */
  url: string
}

/**
 * Outfit arrives from Google Fonts, so the first draw can easily beat it and
 * fall back to system-ui at the wrong metrics. Each weight is asked for by
 * name: `fonts.ready` alone resolves before a face nothing has used yet is
 * fetched.
 */
async function waitForFont(): Promise<void> {
  if (!document.fonts) return
  await Promise.all([
    document.fonts.load(`600 200px ${FONT}`),
    document.fonts.load(`500 34px ${FONT}`),
    document.fonts.load(`400 26px ${FONT}`),
  ]).catch(() => undefined)
  await document.fonts.ready.catch(() => undefined)
}

/**
 * The card art, sized so a canvas will take it.
 *
 * The SVGs carry a viewBox and no width/height. Chrome infers a size from the
 * viewBox; Firefox refuses and draws nothing. So the markup is fetched and
 * stamped with explicit dimensions before it becomes an image -- which also
 * keeps the whole thing same-origin, since a blob URL inherits nothing.
 */
async function loadArt(issuer: string, name: string): Promise<HTMLImageElement | null> {
  try {
    const source = await fetch(cardArtSrc(issuer, name)).then((r) => (r.ok ? r.text() : null))
    if (!source) return null

    const sized = source.replace('<svg', `<svg width="${ART_W}" height="${ART_H}"`)
    const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }))

    try {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = url
      })
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch {
    // A missing tile is worth less than a failed share.
    return null
  }
}

function centred(ctx: CanvasRenderingContext2D, text: string, y: number): void {
  ctx.fillText(text, SIZE / 2, y)
}

/** Greedy wrap, returning the y the next line would start on. */
function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  const words = text.split(' ')
  let line = ''
  let cursor = y

  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width > maxWidth && line) {
      centred(ctx, line, cursor)
      cursor += lineHeight
      line = word
    } else {
      line = next
    }
  }
  if (line) {
    centred(ctx, line, cursor)
    cursor += lineHeight
  }
  return cursor
}

/** A rounded, tinted capsule with a label, returning its width. */
function pill(
  ctx: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
  colour: string,
  tint: string,
  border: string,
): number {
  ctx.font = `600 26px ${FONT}`
  const width = ctx.measureText(label).width + 56
  const height = 58

  ctx.beginPath()
  ctx.roundRect(x, y, width, height, height / 2)
  ctx.fillStyle = tint
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = border
  ctx.stroke()

  ctx.fillStyle = colour
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + width / 2, y + height / 2 + 1)
  ctx.textBaseline = 'alphabetic'

  return width
}

/** The stacked pile, drawn the way DeckStrip lays it out on screen. */
function drawDeck(
  ctx: CanvasRenderingContext2D,
  art: (HTMLImageElement | null)[],
  y: number,
): void {
  const total = TILE_W + (art.length - 1) * TILE_STEP
  const left = (SIZE - total) / 2

  // Back to front, so the first card ends up on top of the pile.
  for (let i = art.length - 1; i >= 0; i -= 1) {
    const x = left + i * TILE_STEP
    const image = art[i]

    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, y, TILE_W, TILE_H, 22)
    ctx.fillStyle = '#15151d'
    ctx.fill()

    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = 40
    ctx.shadowOffsetX = 16
    ctx.shadowOffsetY = 18
    ctx.fill()
    ctx.shadowColor = 'transparent'

    if (image) {
      ctx.clip()
      // Receding into the pile, as the tiles dim on screen.
      ctx.globalAlpha = 1 - (art.length < 2 ? 0 : i / (art.length - 1)) * 0.34
      ctx.drawImage(image, x, y, TILE_W, TILE_H)
      ctx.globalAlpha = 1
    }
    ctx.restore()

    ctx.beginPath()
    ctx.roundRect(x, y, TILE_W, TILE_H, 22)
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'
    ctx.stroke()
  }
}

export async function renderShareImage(card: ShareCard): Promise<Blob> {
  await waitForFont()

  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser would not give us a canvas to draw on.')

  ctx.fillStyle = BG
  ctx.fillRect(0, 0, SIZE, SIZE)

  // The profile screen's own glows, at this scale.
  for (const glow of [
    { x: 900, y: 120, r: 560, colour: 'rgba(251,146,60,0.22)' },
    { x: 120, y: 620, r: 620, colour: 'rgba(124,58,237,0.42)' },
    { x: 980, y: 1020, r: 520, colour: 'rgba(30,27,75,0.85)' },
  ]) {
    const gradient = ctx.createRadialGradient(glow.x, glow.y, 0, glow.x, glow.y, glow.r)
    gradient.addColorStop(0, glow.colour)
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, SIZE, SIZE)
  }

  ctx.textAlign = 'center'

  ctx.fillStyle = MUTED
  ctx.font = `500 24px ${FONT}`
  // Guarded: letterSpacing is recent, and its absence should cost tracking,
  // not the whole image.
  if ('letterSpacing' in ctx) ctx.letterSpacing = '7px'
  centred(ctx, card.domain.toUpperCase(), 108)
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'

  ctx.fillStyle = card.tier.color
  ctx.font = `600 62px ${FONT}`
  centred(ctx, card.handle, 232)

  ctx.font = `600 210px ${FONT}`
  centred(ctx, String(card.rating), 420)

  ctx.fillStyle = MUTED
  ctx.font = `500 30px ${FONT}`
  centred(ctx, `out of ${card.maxScore}`, 470)

  // Both pills on one centred row, measured first so the pair sits square.
  ctx.font = `600 26px ${FONT}`
  const tierWidth = ctx.measureText(card.tier.name.toUpperCase()).width + 56
  const verifiedLabel = `✓ ${card.verifiedCount} VERIFIED`
  const verifiedWidth = ctx.measureText(verifiedLabel).width + 56
  const gap = 16
  let x = (SIZE - (tierWidth + gap + verifiedWidth)) / 2

  x += pill(
    ctx,
    card.tier.name.toUpperCase(),
    x,
    528,
    card.tier.color,
    `${card.tier.color}24`,
    `${card.tier.color}61`,
  )
  pill(
    ctx,
    verifiedLabel,
    x + gap,
    528,
    '#34d399',
    'rgba(52,211,153,0.12)',
    'rgba(52,211,153,0.35)',
  )

  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = `400 34px ${FONT}`
  ctx.textAlign = 'center'
  const afterSummary = wrap(ctx, card.summary, 648, 780, 48)

  const art = await Promise.all(
    card.cards.slice(0, MAX_TILES).map((c) => loadArt(c.issuer, c.name)),
  )
  if (art.length > 0) drawDeck(ctx, art, Math.max(afterSummary + 40, 726))

  ctx.fillStyle = MUTED
  ctx.font = `500 26px ${FONT}`
  centred(ctx, card.url.replace(/^https?:\/\//, ''), SIZE - 74)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
      'image/png',
    )
  })
}
