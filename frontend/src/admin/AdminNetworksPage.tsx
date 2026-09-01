import { useCallback, useState } from 'react'
import {
  BIN_RULE_KINDS,
  createNetwork,
  deactivateNetwork,
  listNetworks,
  updateNetwork,
  type AdminNetwork,
  type BinRule,
  type BinRuleKind,
} from '../data/adminApi'
import { ApiError } from '../data/api'
import type { AdminRoute } from '../router/hashRouter'
import { AdminShell } from './AdminShell'
import { useAdminResource } from './useAdminResource'
import { Button, ErrorNote, Field, Note, Panel, Pill, Select, Toggle } from './ui/AdminUi'
import styles from './AdminNetworksPage.module.css'

/**
 * Payment networks and the BIN prefix rules each allocates under.
 *
 * The eight ISO networks are seeded, so this screen exists for the ninth --
 * and for correcting a rule. A network's rules are what decide whether a BIN
 * entered on a card is accepted, so getting one wrong here shows up there.
 */
export function AdminNetworksPage({ route }: { route: AdminRoute }) {
  const [showInactive, setShowInactive] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const networks = useAdminResource(
    (signal) => listNetworks({ includeInactive: showInactive }, signal),
    `networks:${showInactive}`,
  )

  const rows = networks.data?.data ?? []
  const current = rows.find((n) => n.id === selected) ?? null

  const rail = (
    <div className={styles.rail}>
      <div className={styles.railHead}>
        <Toggle label="Show inactive" checked={showInactive} onChange={setShowInactive} />
      </div>

      {networks.status === 'error' ? <ErrorNote message={networks.message} /> : null}

      <ul className={styles.railList}>
        {rows.map((network) => (
          <li key={network.id}>
            <button
              type="button"
              className={network.id === selected ? styles.railItemOn : styles.railItem}
              onClick={() => setSelected(network.id)}
            >
              <span>
                {network.name}
                <span className={styles.railCode}>{network.code}</span>
              </span>
              {network.isActive ? null : <Pill tone="bad">Inactive</Pill>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )

  return (
    <AdminShell route={route} rail={rail}>
      <div className={styles.page}>
        {current ? (
          <NetworkDetail
            key={current.id}
            network={current}
            onChanged={networks.reload}
            onDeselect={() => setSelected(null)}
          />
        ) : (
          <NewNetworkPanel onCreated={networks.reload} />
        )}
      </div>
    </AdminShell>
  )
}

/* ---------------------------------------------------------- rules sub-form */

function RuleRows({
  rules,
  onChange,
  disabled,
}: {
  rules: BinRule[]
  onChange: (rules: BinRule[]) => void
  disabled: boolean
}) {
  const patch = (index: number, next: Partial<BinRule>) =>
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...next } : rule)))

  return (
    <>
      <div className={styles.ruleRows}>
        {rules.map((rule, index) => (
          <div key={index} className={styles.ruleRow}>
            <Select
              label="Kind"
              value={rule.kind}
              onChange={(kind) => patch(index, { kind: kind as BinRuleKind })}
              options={BIN_RULE_KINDS.map((kind) => ({ value: kind, label: kind }))}
              disabled={disabled}
            />
            <Field
              label="Value"
              value={rule.value}
              onChange={(value) => patch(index, { value })}
              placeholder={rule.kind === 'glob' ? '4*' : '2221-2720'}
              disabled={disabled}
            />
            <Button
              variant="danger"
              onClick={() => onChange(rules.filter((_, i) => i !== index))}
              disabled={disabled}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>

      <Button
        onClick={() => onChange([...rules, { kind: 'glob', value: '' }])}
        disabled={disabled}
      >
        Add rule
      </Button>
    </>
  )
}

const RULES_HELP =
  'A glob may hold only digits, [, ], - and *, anchored at both ends — so 4* matches every Visa and 508 alone matches nothing six digits long. A range is two four-digit bounds, low first, checked against the prefix’s leading four digits.'

/* ------------------------------------------------------------------ detail */

function NetworkDetail({
  network,
  onChanged,
  onDeselect,
}: {
  network: AdminNetwork
  onChanged: () => void
  onDeselect: () => void
}) {
  // Null means untouched, so the form shows the server's values and a
  // successful save needs no resync -- the reload it triggers is the resync.
  const [edited, setEdited] = useState<{ name: string; rules: BinRule[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [saved, setSaved] = useState(false)

  const name = edited?.name ?? network.name
  const rules = edited?.rules ?? network.binRules

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      setSaved(false)
      try {
        await action()
        setEdited(null)
        setSaved(true)
        onChanged()
      } catch (err) {
        setError(err instanceof Error ? err : new Error('That did not work.'))
      } finally {
        setBusy(false)
      }
    },
    [onChanged],
  )

  return (
    <Panel
      title={`${network.name} (${network.code})`}
      subtitle={RULES_HELP}
      actions={
        <>
          <Button variant="ghost" onClick={onDeselect} disabled={busy}>
            New network
          </Button>
          {network.isActive ? (
            <Button
              variant="danger"
              onClick={() => run(() => deactivateNetwork(network.id))}
              disabled={busy}
            >
              Deactivate
            </Button>
          ) : (
            <Button
              onClick={() => run(() => updateNetwork(network.id, { isActive: true }))}
              disabled={busy}
            >
              Reactivate
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => run(() => updateNetwork(network.id, { name: name.trim(), binRules: rules }))}
            disabled={busy}
          >
            {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
          </Button>
        </>
      }
    >
      <div className={styles.detailHead}>
        <Field
          label="Name"
          value={name}
          onChange={(next) => setEdited({ name: next, rules })}
          maxLength={40}
          disabled={busy}
        />
        <Field label="Code" value={network.code} onChange={() => {}} disabled hint="Not editable here — it is the wire value cards refer to." />
      </div>

      {!network.isActive ? (
        <Note>
          Deactivated. Cards already on this network keep it and it still works as a filter, but
          new card writes will reject it.
        </Note>
      ) : null}

      {rules.length === 0 ? (
        <Note>
          No rules. Saving with none clears them, and the network then rejects every BIN until
          rules come back.
        </Note>
      ) : null}

      <RuleRows
        rules={rules}
        onChange={(next) => setEdited({ name, rules: next })}
        disabled={busy}
      />

      {error ? (
        <ErrorNote
          message={error.message}
          details={error instanceof ApiError ? error.details : undefined}
        />
      ) : null}
    </Panel>
  )
}

/* --------------------------------------------------------------------- new */

function NewNetworkPanel({ onCreated }: { onCreated: () => void }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [rules, setRules] = useState<BinRule[]>([{ kind: 'glob', value: '' }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await createNetwork({
        code: code.trim().toLowerCase(),
        name: name.trim(),
        binRules: rules.filter((rule) => rule.value.trim().length > 0),
      })
      setCode('')
      setName('')
      setRules([{ kind: 'glob', value: '' }])
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Could not create the network.'))
    } finally {
      setBusy(false)
    }
  }, [code, name, rules, onCreated])

  return (
    <Panel
      title="Add a network"
      subtitle={`Eight are already seeded — this is for a ninth. ${RULES_HELP}`}
      actions={
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || code.trim().length === 0 || name.trim().length === 0}
        >
          {busy ? 'Adding…' : 'Add network'}
        </Button>
      }
    >
      <div className={styles.detailHead}>
        <Field
          label="Name"
          value={name}
          onChange={setName}
          placeholder="Elo"
          maxLength={40}
          disabled={busy}
        />
        <Field
          label="Code"
          value={code}
          onChange={setCode}
          placeholder="elo"
          maxLength={20}
          hint="2–20 lowercase letters or digits. This is what the API speaks."
          disabled={busy}
        />
      </div>

      <Note>At least one rule is required — a network with none can never accept a BIN.</Note>

      <RuleRows rules={rules} onChange={setRules} disabled={busy} />

      {error ? (
        <ErrorNote
          message={error.message}
          details={error instanceof ApiError ? error.details : undefined}
        />
      ) : null}
    </Panel>
  )
}
