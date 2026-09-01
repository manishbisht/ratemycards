import { useCallback, useState } from 'react'
import { listCriteria, type AdminCriterion } from '../data/adminApi'
import { request } from '../data/api'
import { ApiError } from '../data/api'
import type { AdminRoute } from '../router/hashRouter'
import { AdminShell } from './AdminShell'
import { useAdminResource } from './useAdminResource'
import { Button, Empty, ErrorNote, Field, Note, Panel, Pill, Toggle } from './ui/AdminUi'
import styles from './AdminCriteriaPage.module.css'

/**
 * The scoring rubric: the criteria every card is judged against, and what each
 * is worth.
 *
 * Weights are relative, not percentages -- a rating is the weighted average
 * over the criteria a card has been scored on, so the total need not be 100.
 */
export function AdminCriteriaPage({ route }: { route: AdminRoute }) {
  const [showInactive, setShowInactive] = useState(false)
  const criteria = useAdminResource(
    (signal) => listCriteria({ includeInactive: showInactive }, signal),
    `criteria:${showInactive}`,
  )

  const rows = criteria.data?.data ?? []
  const activeWeight = rows
    .filter((row) => row.isActive)
    .reduce((total, row) => total + row.weight, 0)

  return (
    <AdminShell route={route}>
      <div className={styles.page}>
        <Panel
          title="Rubric"
          subtitle="Every active criterion contributes to every card's rating, weighted. Deactivating one re-rates the whole catalog immediately."
          actions={<Toggle label="Show inactive" checked={showInactive} onChange={setShowInactive} />}
        >
          {criteria.status === 'error' ? <ErrorNote message={criteria.message} /> : null}
          <Note>Active weights total {activeWeight}.</Note>

          <div className={styles.rows}>
            {rows.map((criterion) => (
              <CriterionRow key={criterion.id} criterion={criterion} onChanged={criteria.reload} />
            ))}
          </div>

          {criteria.status === 'ready' && rows.length === 0 ? <Empty>No criteria.</Empty> : null}
        </Panel>

        <NewCriterionPanel onCreated={criteria.reload} />
      </div>
    </AdminShell>
  )
}

/* The rubric is small and rarely touched, so its two writes live here rather
   than widening adminApi.ts for a screen that is one step from read-only. */
function patchCriterion(id: string, patch: Record<string, unknown>) {
  return request<AdminCriterion>(`/v1/criteria/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

function CriterionRow({
  criterion,
  onChanged,
}: {
  criterion: AdminCriterion
  onChanged: () => void
}) {
  const [weight, setWeight] = useState(String(criterion.weight))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await action()
        onChanged()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That did not work.')
      } finally {
        setBusy(false)
      }
    },
    [onChanged],
  )

  const changed = weight.trim() !== String(criterion.weight) && weight.trim().length > 0

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowName}>
          {criterion.name}
          {criterion.isActive ? null : <Pill tone="bad">Inactive</Pill>}
        </div>
        {criterion.description ? (
          <p className={styles.rowDescription}>{criterion.description}</p>
        ) : null}
        {error ? <div className={styles.rowError}>{error}</div> : null}
      </div>

      <input
        className={styles.weight}
        type="number"
        min={0}
        max={100}
        value={weight}
        disabled={busy}
        onChange={(event) => setWeight(event.target.value)}
        aria-label={`${criterion.name} weight`}
      />

      <Button
        onClick={() => run(() => patchCriterion(criterion.id, { weight: Number(weight) }))}
        disabled={busy || !changed}
      >
        Save
      </Button>

      {criterion.isActive ? (
        <Button
          variant="danger"
          disabled={busy}
          onClick={() =>
            run(() => request<void>(`/v1/criteria/${criterion.id}`, { method: 'DELETE' }))
          }
        >
          Deactivate
        </Button>
      ) : (
        <Button
          disabled={busy}
          onClick={() => run(() => patchCriterion(criterion.id, { isActive: true }))}
        >
          Reactivate
        </Button>
      )}
    </div>
  )
}

function NewCriterionPanel({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [weight, setWeight] = useState('10')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await request<AdminCriterion>('/v1/criteria', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          weight: Number(weight || 0),
        }),
      })
      setName('')
      setDescription('')
      setWeight('10')
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not create the criterion.'))
    } finally {
      setBusy(false)
    }
  }, [name, description, weight, onCreated])

  return (
    <Panel
      title="Add a criterion"
      subtitle="A new criterion starts unscored on every card, which lowers no rating — a rating averages only the criteria a card has actually been scored on."
      actions={
        <Button variant="primary" onClick={submit} disabled={busy || name.trim().length === 0}>
          {busy ? 'Adding…' : 'Add criterion'}
        </Button>
      }
    >
      <div className={styles.newRow}>
        <Field label="Name" value={name} onChange={setName} maxLength={80} disabled={busy} />
        <Field
          label="Description"
          value={description}
          onChange={setDescription}
          maxLength={300}
          disabled={busy}
        />
        <Field label="Weight" type="number" value={weight} onChange={setWeight} disabled={busy} />
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
