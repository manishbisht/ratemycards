import { useCallback, useState } from 'react'
import { createBank, listBanks, type AdminBank } from '../data/adminApi'
import { ApiError } from '../data/api'
import { hrefFor, navigate } from '../router/hashRouter'
import type { AdminRoute } from '../router/hashRouter'
import { AdminShell } from './AdminShell'
import { AdminBankDetail } from './AdminBankDetail'
import { useAdminResource } from './useAdminResource'
import { Button, Empty, ErrorNote, Field, Pill, Toggle } from './ui/AdminUi'
import styles from './AdminBanksPage.module.css'

/**
 * The bank list in the rail, and either the "new bank" form or one bank's cards
 * in the pane.
 *
 * One component serves both `#/admin/banks` and `#/admin/banks/<id>`: they
 * share the rail, and its search box and inactive toggle should not reset when
 * a bank is opened.
 */
export function AdminBanksPage({ route, bankId }: { route: AdminRoute; bankId?: string }) {
  const [query, setQuery] = useState('')
  const [showInactive, setShowInactive] = useState(false)

  const banks = useAdminResource(
    (signal) => listBanks({ q: query || undefined, includeInactive: showInactive }, signal),
    `banks:${query}:${showInactive}`,
  )

  const rail = (
    <div className={styles.rail}>
      <div className={styles.railHead}>
        <Field label="Search banks" value={query} onChange={setQuery} placeholder="HDFC" />
        <Toggle label="Show inactive" checked={showInactive} onChange={setShowInactive} />
      </div>

      {banks.status === 'error' ? <ErrorNote message={banks.message} /> : null}

      <ul className={styles.railList}>
        {(banks.data?.data ?? []).map((bank: AdminBank) => (
          <li key={bank.id}>
            <a
              className={bank.id === bankId ? styles.railItemOn : styles.railItem}
              href={hrefFor({ kind: 'adminBank', bankId: bank.id })}
            >
              <span className={styles.railName}>{bank.name}</span>
              {bank.isActive ? null : <Pill tone="bad">Inactive</Pill>}
            </a>
          </li>
        ))}
      </ul>

      {banks.status === 'ready' && banks.data.data.length === 0 ? (
        <Empty>No banks match.</Empty>
      ) : null}

      {banks.data && banks.data.total > banks.data.data.length ? (
        <div className={styles.railFoot}>
          Showing {banks.data.data.length} of {banks.data.total} — narrow the search for the rest.
        </div>
      ) : null}
    </div>
  )

  return (
    <AdminShell route={route} rail={rail}>
      {bankId ? (
        <AdminBankDetail bankId={bankId} onBankChanged={banks.reload} />
      ) : (
        <NewBankPane onCreated={banks.reload} />
      )}
    </AdminShell>
  )
}

function NewBankPane({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const bank = await createBank(name.trim())
      setName('')
      onCreated()
      navigate({ kind: 'adminBank', bankId: bank.id })
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not create the bank.'))
    } finally {
      setBusy(false)
    }
  }, [name, onCreated])

  return (
    <div className={styles.newBank}>
      <h1 className={styles.title}>Banks</h1>
      <p className={styles.lede}>
        Pick a bank on the left to manage the cards it issues, or add one here.
      </p>

      <div className={styles.newBankRow}>
        <Field
          label="Bank name"
          value={name}
          onChange={setName}
          placeholder="HDFC Bank"
          maxLength={80}
          disabled={busy}
        />
        <Button variant="primary" onClick={submit} disabled={busy || name.trim().length === 0}>
          {busy ? 'Adding…' : 'Add bank'}
        </Button>
      </div>

      {error ? (
        <ErrorNote
          message={error.message}
          details={error instanceof ApiError ? error.details : undefined}
        />
      ) : null}

      {/* Card art is resolved from a hardcoded map of bank names, so a new bank
          renders the generic swatch until an SVG is added for it. */}
      <p className={styles.footnote}>
        A new bank shows generic card art until an SVG for its name is added under{' '}
        <code>public/card-art/banks/</code>.
      </p>
    </div>
  )
}
