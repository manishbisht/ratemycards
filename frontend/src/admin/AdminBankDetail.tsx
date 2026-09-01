import { useCallback, useState } from 'react'
import {
  CARD_TYPES,
  createCard,
  deactivateBank,
  deactivateCard,
  getBank,
  listBankCards,
  updateBank,
  updateCard,
  type AdminCard,
  type CardType,
} from '../data/adminApi'
import { ApiError } from '../data/api'
import { hrefFor } from '../router/hashRouter'
import { useAdminResource } from './useAdminResource'
import { Button, Empty, ErrorNote, Field, Note, Panel, Pill, Select, Toggle } from './ui/AdminUi'
import styles from './AdminBankDetail.module.css'

/**
 * One bank: its name and status, and the cards it issues.
 *
 * `onBankChanged` re-reads the rail, because renaming or retiring a bank
 * changes what is listed there.
 */
export function AdminBankDetail({
  bankId,
  onBankChanged,
}: {
  bankId: string
  onBankChanged: () => void
}) {
  const [showInactive, setShowInactive] = useState(false)

  const bank = useAdminResource((signal) => getBank(bankId, signal), `bank:${bankId}`)
  const cards = useAdminResource(
    (signal) => listBankCards(bankId, { includeInactive: showInactive }, signal),
    `bank-cards:${bankId}:${showInactive}`,
  )

  if (bank.status === 'error') return <ErrorNote message={bank.message} />
  if (!bank.data) return <Empty>Loading…</Empty>

  return (
    <div className={styles.page}>
      <BankHeader bank={bank.data} onChanged={() => { bank.reload(); onBankChanged() }} />

      {!bank.data.isActive ? (
        <Note>
          This bank is deactivated, so none of its cards appear in the catalog — including the ones
          still marked active below.
        </Note>
      ) : null}

      <Panel
        title="Cards"
        subtitle="Every card this bank issues. Open one to set the networks it runs on and the BIN prefixes behind each."
        actions={<Toggle label="Show inactive" checked={showInactive} onChange={setShowInactive} />}
      >
        {cards.status === 'error' ? <ErrorNote message={cards.message} /> : null}
        <CardTable cards={cards.data?.data ?? []} onChanged={cards.reload} />
        {cards.status === 'ready' && cards.data.data.length === 0 ? (
          <Empty>No cards yet.</Empty>
        ) : null}
      </Panel>

      <NewCardPanel bankId={bankId} onCreated={cards.reload} />
    </div>
  )
}

function BankHeader({
  bank,
  onChanged,
}: {
  bank: { id: string; name: string; isActive: boolean }
  onChanged: () => void
}) {
  // Null means "not edited", so the field simply shows what the server holds
  // and a successful save needs no resync. Saves one effect and one stale-draft
  // bug apiece.
  const [edited, setEdited] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // The rail can switch banks under this component. Adjusting state during
  // render rather than in an effect is the documented way to reset on a prop
  // change: React re-renders before committing, so the stale name never paints.
  const [shownId, setShownId] = useState(bank.id)
  if (shownId !== bank.id) {
    setShownId(bank.id)
    setEdited(null)
    setError(null)
  }

  const name = edited ?? bank.name

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await action()
        setEdited(null)
        onChanged()
      } catch (err) {
        setError(err instanceof Error ? err : new Error('That did not work.'))
      } finally {
        setBusy(false)
      }
    },
    [onChanged],
  )

  const renamed = name.trim() !== bank.name && name.trim().length > 0

  return (
    <header className={styles.head}>
      <div className={styles.headRow}>
        <Field label="Bank name" value={name} onChange={setEdited} maxLength={80} disabled={busy} />

        <Button
          onClick={() => run(() => updateBank(bank.id, { name: name.trim() }))}
          disabled={busy || !renamed}
        >
          Rename
        </Button>

        {bank.isActive ? (
          <Button variant="danger" onClick={() => run(() => deactivateBank(bank.id))} disabled={busy}>
            Deactivate
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => run(() => updateBank(bank.id, { isActive: true }))}
            disabled={busy}
          >
            Reactivate
          </Button>
        )}
      </div>

      {error ? (
        <ErrorNote
          message={error.message}
          details={error instanceof ApiError ? error.details : undefined}
        />
      ) : null}
    </header>
  )
}

function CardTable({ cards, onChanged }: { cards: AdminCard[]; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const toggle = useCallback(
    async (card: AdminCard) => {
      setBusyId(card.id)
      setErrors((prev) => ({ ...prev, [card.id]: '' }))
      try {
        if (card.isActive) await deactivateCard(card.id)
        else await updateCard(card.id, { isActive: true })
        onChanged()
      } catch (err) {
        setErrors((prev) => ({
          ...prev,
          [card.id]: err instanceof Error ? err.message : 'That did not work.',
        }))
      } finally {
        setBusyId(null)
      }
    },
    [onChanged],
  )

  if (cards.length === 0) return null

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Card</th>
          <th>Type</th>
          <th>Country</th>
          <th className={styles.num}>Joining</th>
          <th className={styles.num}>Annual</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {cards.map((card) => (
          <tr key={card.id}>
            <td>
              <a className={styles.cardLink} href={hrefFor({ kind: 'adminCard', cardId: card.id })}>
                {card.name}
              </a>
              {errors[card.id] ? <div className={styles.rowError}>{errors[card.id]}</div> : null}
            </td>
            <td className={styles.muted}>{card.type}</td>
            <td className={styles.muted}>{card.country}</td>
            <td className={styles.num}>{card.joiningFee.toLocaleString('en-IN')}</td>
            <td className={styles.num}>{card.annualFee.toLocaleString('en-IN')}</td>
            <td>
              {/* The flex container is this span, not the cell: `display: flex`
                  on a <td> overrides `display: table-cell` and drops it out of
                  the column alignment the rest of the row relies on. */}
              <span className={styles.status}>
                {card.isActive ? null : <Pill tone="bad">Inactive</Pill>}
                {/* Selectable means at least one BIN prefix is on file. Without
                    one the card cannot be verified and is hidden from browse. */}
                {card.selectable ? (
                  <Pill tone="good">Selectable</Pill>
                ) : (
                  <Pill tone="warn">No BINs</Pill>
                )}
              </span>
            </td>
            <td className={styles.rowActions}>
              <Button variant="ghost" onClick={() => toggle(card)} disabled={busyId === card.id}>
                {card.isActive ? 'Deactivate' : 'Reactivate'}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const BLANK_CARD = { name: '', country: 'IN', type: 'credit' as CardType, joiningFee: '0', annualFee: '0' }

function NewCardPanel({ bankId, onCreated }: { bankId: string; onCreated: () => void }) {
  const [draft, setDraft] = useState(BLANK_CARD)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const set = <K extends keyof typeof BLANK_CARD>(key: K, value: (typeof BLANK_CARD)[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }))

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await createCard({
        bankId,
        name: draft.name.trim(),
        country: draft.country.trim().toUpperCase(),
        type: draft.type,
        // Whole rupees, not paise. An empty box means zero rather than a NaN.
        joiningFee: Number(draft.joiningFee || 0),
        annualFee: Number(draft.annualFee || 0),
      })
      setDraft(BLANK_CARD)
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not create the card.'))
    } finally {
      setBusy(false)
    }
  }, [bankId, draft, onCreated])

  return (
    <Panel
      title="Add a card"
      subtitle="Networks and BIN prefixes are set afterwards, on the card's own screen."
    >
      <div className={styles.newCard}>
        <Field
          label="Name"
          value={draft.name}
          onChange={(v) => set('name', v)}
          placeholder="Infinia Metal"
          maxLength={120}
          disabled={busy}
        />
        <Field
          label="Country"
          value={draft.country}
          onChange={(v) => set('country', v)}
          maxLength={2}
          hint="ISO 3166-1 alpha-2"
          disabled={busy}
        />
        <Select
          label="Type"
          value={draft.type}
          onChange={(v) => set('type', v as CardType)}
          options={CARD_TYPES.map((type) => ({ value: type, label: type }))}
          disabled={busy}
        />
        <Field
          label="Joining fee"
          type="number"
          value={draft.joiningFee}
          onChange={(v) => set('joiningFee', v)}
          hint="Whole rupees"
          disabled={busy}
        />
        <Field
          label="Annual fee"
          type="number"
          value={draft.annualFee}
          onChange={(v) => set('annualFee', v)}
          hint="Whole rupees"
          disabled={busy}
        />
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || draft.name.trim().length === 0}
        >
          {busy ? 'Adding…' : 'Add card'}
        </Button>
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
