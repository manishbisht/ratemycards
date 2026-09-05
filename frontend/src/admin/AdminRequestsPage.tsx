import { useState } from 'react'
import { ApiError } from '../data/api'
import {
  CARD_TYPES,
  approveCardRequest,
  createBank,
  createCard,
  listCardRequests,
  mergeCardBins,
  rejectCardRequest,
} from '../data/adminApi'
import type { AdminCardRequest, CardType, RequestStatus } from '../data/adminApi'
import { hrefFor } from '../router/hashRouter'
import type { AdminRoute } from '../router/hashRouter'
import { AdminShell } from './AdminShell'
import { Button, Empty, ErrorNote, Field, Note, Panel, Pill, Select } from './ui/AdminUi'
import { useAdminResource } from './useAdminResource'
import styles from './AdminRequestsPage.module.css'

const TABS: { label: string; status: RequestStatus }[] = [
  { label: 'Pending', status: 'pending' },
  { label: 'Approved', status: 'approved' },
  { label: 'Declined', status: 'rejected' },
]

/**
 * The card and BIN people asked for, and the queue for answering them.
 *
 * NOTHING HERE APPROVES ITS WAY INTO THE CATALOG. Approval is a record that the
 * work was done, so every row does the real write first -- through the same
 * /v1/banks and /v1/cards the rest of the console uses -- and only then settles
 * the request. That is also why a BIN row links out to the card editor rather
 * than rebuilding it: `replaceCardNetworks` is a full replace, and the editor
 * already reads the current set before sending one back. See `mergeCardBins`.
 */
export function AdminRequestsPage({ route }: { route: AdminRoute }) {
  const [status, setStatus] = useState<RequestStatus>('pending')
  const queue = useAdminResource(
    (signal) => listCardRequests({ status }, signal),
    `requests:${status}`,
  )

  return (
    <AdminShell route={route}>
      <Panel
        title="Requests"
        subtitle="Cards and BIN prefixes people have asked for."
        actions={
          <div className={styles.tabs}>
            {TABS.map((tab) => (
              <button
                key={tab.status}
                type="button"
                className={tab.status === status ? styles.tabOn : styles.tab}
                onClick={() => setStatus(tab.status)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        }
      >
        {queue.status === 'error' ? <ErrorNote message={queue.message} /> : null}

        {queue.data === null ? (
          <Note>Loading…</Note>
        ) : queue.data.data.length === 0 ? (
          <Empty>Nothing {status === 'pending' ? 'waiting' : `marked ${status}`}.</Empty>
        ) : (
          <div className={styles.rows}>
            {queue.data.data.map((request) => (
              <RequestRow key={request.id} request={request} onDone={queue.reload} />
            ))}
          </div>
        )}

        {queue.data && queue.data.total > queue.data.data.length ? (
          <Note>
            Showing {queue.data.data.length} of {queue.data.total}.
          </Note>
        ) : null}
      </Panel>
    </AdminShell>
  )
}

/** Whatever the API said went wrong, with every fault behind a 400. */
function faultOf(err: unknown): { message: string; details?: string[] } {
  if (err instanceof ApiError) return { message: err.message, details: err.details }
  return { message: err instanceof Error ? err.message : 'Something went wrong.' }
}

function RequestRow({ request, onDone }: { request: AdminCardRequest; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [fault, setFault] = useState<{ message: string; details?: string[] } | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')

  // The requester's values are the draft. Every one is editable, because a
  // request is a claim: the issuer may be spelled three ways and the network
  // may simply be wrong.
  const [name, setName] = useState(request.proposal?.name ?? '')
  const [issuer, setIssuer] = useState(request.proposal?.issuer ?? '')
  const [type, setType] = useState<CardType>(request.proposal?.type ?? 'credit')
  const [country, setCountry] = useState('IN')
  const [joiningFee, setJoiningFee] = useState('0')
  const [annualFee, setAnnualFee] = useState('0')
  const [bins, setBins] = useState(request.bins.join(', '))

  const settled = request.status !== 'pending'

  function prefixes(): string[] {
    return bins
      .split(/[\s,]+/)
      .map((bin) => bin.trim())
      .filter(Boolean)
  }

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setFault(null)
    try {
      await work()
      onDone()
    } catch (err) {
      setFault(faultOf(err))
    } finally {
      setBusy(false)
    }
  }

  /** Create the bank if it is new, create the card, then record the approval. */
  const addAndApprove = () =>
    run(async () => {
      const bankId = request.proposal?.bankId ?? (await createBank(issuer.trim())).id
      const list = prefixes()

      const card = await createCard({
        bankId,
        name: name.trim(),
        country: country.trim().toUpperCase(),
        type,
        joiningFee: Number(joiningFee) || 0,
        annualFee: Number(annualFee) || 0,
        // One write rather than a create then a PATCH.
        ...(list.length ? { networks: [{ code: request.network, bins: list }] } : {}),
      })

      await approveCardRequest(request.id, { cardId: card.id })
    })

  /**
   * Add the prefixes to the card, then record the approval.
   *
   * Empty is a real answer: it means the admin already did the work in the card
   * editor, or judged the proposed prefixes wrong and put different ones on.
   * Approval does not check that what was asked for is what was recorded --
   * insisting on that would make a corrected prefix impossible to approve.
   */
  const fillAndApprove = () =>
    run(async () => {
      const list = prefixes()
      if (list.length && request.card) {
        await mergeCardBins(request.card.id, request.network, list)
      }
      await approveCardRequest(request.id)
    })

  const reject = () => run(() => rejectCardRequest(request.id, note.trim()).then(() => undefined))

  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <div>
          <div className={styles.title}>
            {request.kind === 'bin'
              ? (request.card?.name ?? 'A card we no longer carry')
              : `${request.proposal?.issuer} ${request.proposal?.name}`}
          </div>
          <div className={styles.sub}>
            {request.kind === 'bin' ? request.card?.issuer : 'Not in the catalog'} ·{' '}
            {new Date(request.createdAt).toLocaleDateString('en-IN', {
              day: 'numeric',
              month: 'short',
            })}
            {request.requester.handle ? ` · @${request.requester.handle}` : ''}
          </div>
        </div>
        <div className={styles.pills}>
          <Pill tone={request.kind === 'bin' ? 'warn' : 'neutral'}>
            {request.kind === 'bin' ? 'Needs BINs' : 'New card'}
          </Pill>
          <Pill>{request.network}</Pill>
          {request.card && !request.card.selectable ? <Pill tone="bad">No BINs</Pill> : null}
          {settled ? (
            <Pill tone={request.status === 'approved' ? 'good' : 'bad'}>{request.status}</Pill>
          ) : null}
        </div>
      </div>

      {request.bins.length > 0 ? (
        <div className={styles.pills}>
          {request.bins.map((bin) => (
            <Pill key={bin}>{bin}</Pill>
          ))}
        </div>
      ) : null}

      {request.note ? <Note>“{request.note}”</Note> : null}
      {request.reviewNote ? <Note>Reply: {request.reviewNote}</Note> : null}

      {settled ? null : (
        <>
          {request.kind === 'card' ? (
            <div className={styles.grid}>
              <Field label="Bank" value={issuer} onChange={setIssuer} />
              <Field label="Card" value={name} onChange={setName} />
              <Select
                label="Type"
                value={type}
                onChange={(value) => setType(value as CardType)}
                options={CARD_TYPES.map((value) => ({ value, label: value }))}
              />
              <Field label="Country" value={country} onChange={setCountry} />
              <Field label="Joining fee" value={joiningFee} onChange={setJoiningFee} />
              <Field label="Annual fee" value={annualFee} onChange={setAnnualFee} />
              <Field
                label={`BINs for ${request.network}`}
                value={bins}
                onChange={setBins}
                hint="Comma separated. Leave empty to add the card without prefixes."
              />
            </div>
          ) : (
            <div className={styles.grid}>
              <Field
                label={`BINs to record under ${request.network}`}
                value={bins}
                onChange={setBins}
                hint="Comma separated, merged into what the card already has. Empty just approves."
              />
            </div>
          )}

          {request.proposal && !request.proposal.bankId ? (
            <Note>No bank called “{issuer}” yet — approving creates it.</Note>
          ) : null}

          {fault ? <ErrorNote message={fault.message} details={fault.details} /> : null}

          {rejecting ? (
            <div className={styles.reject}>
              <Field
                label="Why not?"
                value={note}
                onChange={setNote}
                hint="The person who asked sees this."
              />
              <div className={styles.actions}>
                <Button variant="danger" disabled={busy || !note.trim()} onClick={reject}>
                  Decline
                </Button>
                <Button variant="ghost" onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.actions}>
              {request.kind === 'card' ? (
                <Button
                  variant="primary"
                  disabled={busy || !name.trim() || !issuer.trim()}
                  onClick={addAndApprove}
                >
                  {busy ? 'Working…' : 'Add card and approve'}
                </Button>
              ) : (
                <>
                  <Button variant="primary" disabled={busy || !request.card} onClick={fillAndApprove}>
                    {busy ? 'Working…' : 'Record BINs and approve'}
                  </Button>
                  {request.card ? (
                    <a
                      className={styles.link}
                      href={hrefFor({ kind: 'adminCard', cardId: request.card.id })}
                    >
                      Open the card editor
                    </a>
                  ) : null}
                </>
              )}
              <Button variant="ghost" onClick={() => setRejecting(true)}>
                Decline
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
