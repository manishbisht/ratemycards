import { useCallback, useMemo, useState } from 'react'
import {
  CARD_TYPES,
  getCard,
  getCardScores,
  listCardNetworks,
  listCriteria,
  listNetworks,
  replaceCardNetworks,
  replaceCardScores,
  updateCard,
  type AdminCard,
  type AdminCriterion,
  type CardNetwork,
  type CardScores,
  type CardType,
  type Rating,
} from '../data/adminApi'
import { ApiError } from '../data/api'
import { hrefFor } from '../router/hashRouter'
import type { AdminRoute } from '../router/hashRouter'
import { AdminShell } from './AdminShell'
import { useAdminResource } from './useAdminResource'
import { Button, Empty, ErrorNote, Field, Note, Panel, Pill, Select } from './ui/AdminUi'
import styles from './AdminCardPage.module.css'

/**
 * One card: its fields, the networks it runs on with their BIN prefixes, and
 * its scores against the rubric.
 *
 * Full width, no rail — the two editors are wide and the bank list is one
 * breadcrumb away.
 */
export function AdminCardPage({ route, cardId }: { route: AdminRoute; cardId: string }) {
  const card = useAdminResource((signal) => getCard(cardId, signal), `card:${cardId}`)

  return (
    <AdminShell route={route}>
      {card.status === 'error' ? <ErrorNote message={card.message} /> : null}
      {card.data ? (
        <div className={styles.page}>
          <nav className={styles.crumbs}>
            <a href={hrefFor({ kind: 'adminBanks' })}>Banks</a>
            <span aria-hidden="true">/</span>
            <a href={hrefFor({ kind: 'adminBank', bankId: card.data.bank.id })}>
              {card.data.bank.name}
            </a>
            <span aria-hidden="true">/</span>
            <span className={styles.crumbNow}>{card.data.name}</span>
          </nav>

          <CardFields card={card.data} onSaved={card.reload} />

          <div className={styles.columns}>
            <NetworksPanel cardId={cardId} onSaved={card.reload} />
            <ScoresPanel cardId={cardId} />
          </div>
        </div>
      ) : card.status === 'loading' ? (
        <Empty>Loading…</Empty>
      ) : null}
    </AdminShell>
  )
}

/* ------------------------------------------------------------------ fields */

type CardDraft = {
  name: string
  country: string
  type: CardType
  joiningFee: string
  annualFee: string
}

function draftOf(card: AdminCard): CardDraft {
  return {
    name: card.name,
    country: card.country,
    type: card.type,
    joiningFee: String(card.joiningFee),
    annualFee: String(card.annualFee),
  }
}

function CardFields({ card, onSaved }: { card: AdminCard; onSaved: () => void }) {
  // Null means untouched, so the fields show the server's values and a save
  // needs no resync -- the reload it triggers is the resync.
  const [edited, setEdited] = useState<CardDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [saved, setSaved] = useState(false)

  const [shownId, setShownId] = useState(card.id)
  if (shownId !== card.id) {
    setShownId(card.id)
    setEdited(null)
    setSaved(false)
  }

  const draft = edited ?? draftOf(card)
  const setDraft = (next: (prev: CardDraft) => CardDraft) => setEdited(next(draft))

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await updateCard(card.id, {
        name: draft.name.trim(),
        country: draft.country.trim().toUpperCase(),
        type: draft.type,
        joiningFee: Number(draft.joiningFee || 0),
        annualFee: Number(draft.annualFee || 0),
      })
      setEdited(null)
      setSaved(true)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not save the card.'))
    } finally {
      setBusy(false)
    }
  }, [card.id, draft, onSaved])

  return (
    <Panel
      title="Card"
      actions={
        <>
          {card.isActive ? null : <Pill tone="bad">Inactive</Pill>}
          {card.selectable ? <Pill tone="good">Selectable</Pill> : <Pill tone="warn">No BINs</Pill>}
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : saved ? 'Saved' : 'Save card'}
          </Button>
        </>
      }
    >
      <div className={styles.fields}>
        <Field
          label="Name"
          value={draft.name}
          onChange={(v) => setDraft((p) => ({ ...p, name: v }))}
          maxLength={120}
          disabled={busy}
        />
        <Field
          label="Country"
          value={draft.country}
          onChange={(v) => setDraft((p) => ({ ...p, country: v }))}
          maxLength={2}
          disabled={busy}
        />
        <Select
          label="Type"
          value={draft.type}
          onChange={(v) => setDraft((p) => ({ ...p, type: v as CardType }))}
          options={CARD_TYPES.map((type) => ({ value: type, label: type }))}
          disabled={busy}
        />
        <Field
          label="Joining fee"
          type="number"
          value={draft.joiningFee}
          onChange={(v) => setDraft((p) => ({ ...p, joiningFee: v }))}
          disabled={busy}
        />
        <Field
          label="Annual fee"
          type="number"
          value={draft.annualFee}
          onChange={(v) => setDraft((p) => ({ ...p, annualFee: v }))}
          disabled={busy}
        />
      </div>

      {error ? (
        <ErrorNote
          message={error.message}
          details={error instanceof ApiError ? error.details : undefined}
        />
      ) : null}
    </Panel>
  )
}

/* ------------------------------------------------------- networks and BINs */

/** The editor's working copy: prefixes are a raw string until they are saved. */
type NetworkDraft = { code: string; bins: string }

function toDraft(rows: CardNetwork[]): NetworkDraft[] {
  return rows.map((row) => ({ code: row.network, bins: row.bins.join(', ') }))
}

function parseBins(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((bin) => bin.trim())
    .filter((bin) => bin.length > 0)
}

function NetworksPanel({ cardId, onSaved }: { cardId: string; onSaved: () => void }) {
  const current = useAdminResource(
    (signal) => listCardNetworks(cardId, signal),
    `card-networks:${cardId}`,
  )
  const available = useAdminResource((signal) => listNetworks({}, signal), 'networks')

  // Null means untouched: the panel shows the server's set, and clearing the
  // draft after a save is what makes the reload authoritative.
  const [edited, setEdited] = useState<NetworkDraft[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [saved, setSaved] = useState(false)

  const { reload } = current

  const [shownId, setShownId] = useState(cardId)
  if (shownId !== cardId) {
    setShownId(cardId)
    setEdited(null)
    setSaved(false)
  }

  const server = current.data
  const rows = useMemo(() => edited ?? (server ? toDraft(server.data) : []), [edited, server])
  const used = new Set(rows.map((row) => row.code))
  const unused = (available.data?.data ?? []).filter((n) => n.isActive && !used.has(n.code))

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await replaceCardNetworks(
        cardId,
        rows.map((row) => ({ code: row.code, bins: parseBins(row.bins) })),
      )
      setEdited(null)
      setSaved(true)
      reload()
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not save the networks.'))
    } finally {
      setBusy(false)
    }
  }, [cardId, rows, reload, onSaved])

  return (
    <Panel
      title="Networks & BINs"
      subtitle="Saving replaces the whole set: any network removed here, and every prefix under it, is deleted. A network with no prefixes is a real state — the card runs on it but cannot be verified, so it is hidden from browse."
      actions={
        <Button variant="primary" onClick={save} disabled={busy || current.status === 'loading'}>
          {busy ? 'Saving…' : saved ? 'Saved' : 'Save networks'}
        </Button>
      }
    >
      {current.status === 'error' ? <ErrorNote message={current.message} /> : null}

      {rows.length === 0 && current.status === 'ready' ? (
        <Empty>This card is on no networks.</Empty>
      ) : null}

      <div className={styles.networkRows}>
        {rows.map((row, index) => (
          <div key={row.code} className={styles.networkRow}>
            <div className={styles.networkCode}>{row.code}</div>
            <Field
              label="BIN prefixes"
              value={row.bins}
              onChange={(value) =>
                setEdited(rows.map((r, i) => (i === index ? { ...r, bins: value } : r)))
              }
              placeholder="412345, 45678901"
              hint="6 or 8 digits each, comma or space separated"
              disabled={busy}
            />
            <Button
              variant="danger"
              onClick={() => setEdited(rows.filter((_, i) => i !== index))}
              disabled={busy}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>

      {unused.length > 0 ? (
        <div className={styles.addNetwork}>
          <Select
            label="Add a network"
            value=""
            onChange={(code) => {
              if (code) setEdited([...rows, { code, bins: '' }])
            }}
            options={[
              { value: '', label: 'Choose…' },
              ...unused.map((n) => ({ value: n.code, label: `${n.name} (${n.code})` })),
            ]}
            disabled={busy}
          />
        </div>
      ) : null}

      {error ? (
        <ErrorNote
          message={error.message}
          details={error instanceof ApiError ? error.details : undefined}
        />
      ) : null}
    </Panel>
  )
}

/* ------------------------------------------------------------------ scores */

function ratingLabel(rating: Rating): string {
  if (rating.score === null) return 'Unrated'
  return `${rating.score} / ${rating.max} — ${rating.scoredCriteria} of ${rating.totalCriteria} criteria scored`
}

function scoresToDraft(payload: CardScores): Record<string, string> {
  const draft: Record<string, string> = {}
  for (const entry of payload.data) draft[entry.criterion.id] = String(entry.score)
  return draft
}

function ScoresPanel({ cardId }: { cardId: string }) {
  const scores = useAdminResource((signal) => getCardScores(cardId, signal), `scores:${cardId}`)
  const criteria = useAdminResource((signal) => listCriteria({}, signal), 'criteria')

  const [edited, setEdited] = useState<Record<string, string> | null>(null)
  // The rating a save returned, which is fresher than the one that was read.
  const [savedRating, setSavedRating] = useState<Rating | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [saved, setSaved] = useState(false)

  const [shownId, setShownId] = useState(cardId)
  if (shownId !== cardId) {
    setShownId(cardId)
    setEdited(null)
    setSavedRating(null)
    setSaved(false)
  }

  const server = scores.data
  const draft = useMemo(() => edited ?? (server ? scoresToDraft(server) : {}), [edited, server])
  const rating = savedRating ?? server?.rating ?? null

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      // Replaces the whole set. A blank box means "no score on this criterion"
      // and is therefore omitted rather than sent as a zero -- the two are
      // different: zero counts against the rating, absent does not.
      const payload = Object.entries(draft)
        .filter(([, value]) => value.trim().length > 0)
        .map(([criterionId, value]) => ({ criterionId, score: Number(value) }))

      const result: CardScores = await replaceCardScores(cardId, payload)
      setSavedRating(result.rating)
      setEdited(scoresToDraft(result))
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not save the scores.'))
    } finally {
      setBusy(false)
    }
  }, [cardId, draft])

  const rows: AdminCriterion[] = (criteria.data?.data ?? []).filter((c) => c.isActive)

  return (
    <Panel
      title="Rubric scores"
      subtitle="0 to 10 on each criterion, weighted into the card's rating. Saving replaces the whole set; leave a box empty to record no score at all, which is not the same as a zero."
      actions={
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : saved ? 'Saved' : 'Save scores'}
        </Button>
      }
    >
      {scores.status === 'error' ? <ErrorNote message={scores.message} /> : null}
      {rating ? <Note>Rating: {ratingLabel(rating)}</Note> : null}

      <div className={styles.scoreRows}>
        {rows.map((criterion) => (
          <div key={criterion.id} className={styles.scoreRow}>
            <div className={styles.scoreName}>
              {criterion.name}
              <span className={styles.scoreWeight}>weight {criterion.weight}</span>
            </div>
            <input
              className={styles.scoreInput}
              type="number"
              min={0}
              max={10}
              value={draft[criterion.id] ?? ''}
              placeholder="—"
              disabled={busy}
              onChange={(event) => setEdited({ ...draft, [criterion.id]: event.target.value })}
            />
          </div>
        ))}
      </div>

      {criteria.status === 'ready' && rows.length === 0 ? (
        <Empty>The rubric has no active criteria.</Empty>
      ) : null}

      {error ? (
        <ErrorNote
          message={error.message}
          details={error instanceof ApiError ? error.details : undefined}
        />
      ) : null}
    </Panel>
  )
}
