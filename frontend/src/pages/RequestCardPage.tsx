import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../components/Button'
import { Screen } from '../components/Screen'
import type { GlowSpec } from '../components/Screen'
import {
  ApiError,
  fetchBankOptions,
  fetchMyCardRequests,
  fetchNetworkOptions,
  submitCardRequest,
  withdrawCardRequest,
} from '../data/api'
import {
  REQUEST_STATUS_COLOR,
  REQUEST_STATUS_LABEL,
  requestNote,
  requestTitle,
} from '../data/cardRequests'
import type { BankOption, CardRequest, NetworkOption, RequestKind } from '../data/cardRequests'
import { navigate } from '../router/hashRouter'
import { useAppSelector } from '../store/hooks'
import { selectCatalog, selectWallet } from '../store/selectors'
import styles from './RequestCardPage.module.css'

const GLOWS: GlowSpec[] = [
  { color: 'rgba(251,146,60,0.20)', size: 420, top: -170, left: -130 },
  { color: 'rgba(99,102,241,0.30)', size: 440, bottom: -180, right: -140 },
]

/** Well under the API's cap of 10; nobody knows ten prefixes off the top of their head. */
const MAX_BIN_FIELDS = 4

/**
 * Asking for a card the catalog does not carry, or for the BIN prefixes a card
 * it does carry is missing -- with your own past asks underneath.
 *
 * One screen rather than two routes: the app is one-screen-at-a-time, and the
 * list is the answer to "did that go anywhere", which is the question somebody
 * has the moment after they submit.
 *
 * The card search needs no request of its own. `loadCatalog` already pages the
 * whole catalog into the store with `includeUnselectable: true` -- including
 * the two thirds of it the picker hides -- so this filters that array in memory
 * exactly as CardPickerPage does.
 */
export function RequestCardPage({ cardId }: { cardId: string | null }) {
  const catalog = useAppSelector(selectCatalog)
  const wallet = useAppSelector(selectWallet)
  const signedIn = wallet.user !== null

  // A card in the URL means somebody arrived from a dead end -- a card they
  // hold that cannot be verified -- so the form opens on that question.
  const [kind, setKind] = useState<RequestKind>(cardId ? 'bin' : 'card')
  const [picked, setPicked] = useState<string | null>(cardId)
  const [query, setQuery] = useState('')
  const [bankId, setBankId] = useState('')
  const [cardName, setCardName] = useState('')
  const [network, setNetwork] = useState('')
  const [bins, setBins] = useState<string[]>([''])
  const [note, setNote] = useState('')

  const [networks, setNetworks] = useState<NetworkOption[]>([])
  const [banks, setBanks] = useState<BankOption[]>([])
  const [mine, setMine] = useState<CardRequest[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [faults, setFaults] = useState<string[]>([])
  const [sent, setSent] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    // Both selects, in parallel. A failure leaves one empty and submit
    // disabled, which is a dead form but not a broken page.
    void Promise.all([
      fetchNetworkOptions(controller.signal).then(setNetworks),
      fetchBankOptions(controller.signal).then(setBanks),
    ]).catch(() => undefined)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!signedIn) return
    const controller = new AbortController()
    fetchMyCardRequests(controller.signal)
      .then(setMine)
      .catch(() => setMine([]))
    return () => controller.abort()
  }, [signedIn])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return catalog
      .filter(
        (card) =>
          card.name.toLowerCase().includes(needle) || card.issuer.toLowerCase().includes(needle),
      )
      .slice(0, 6)
  }, [catalog, query])

  const pickedCard = useMemo(
    () => catalog.find((card) => card.id === picked) ?? null,
    [catalog, picked],
  )

  const ready =
    network !== '' &&
    !busy &&
    (kind === 'bin' ? picked !== null : bankId !== '' && cardName.trim() !== '')

  const submit = useCallback(async () => {
    setBusy(true)
    setFaults([])
    setSent(null)

    const prefixes = bins.map((bin) => bin.trim()).filter(Boolean)

    try {
      const created = await submitCardRequest({
        kind,
        ...(kind === 'bin'
          ? { cardId: picked as string }
          // The bank travels as an id. Its name is the catalog's, not ours.
          : { bankId, cardName: cardName.trim() }),
        network,
        ...(prefixes.length ? { bins: prefixes } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      })

      setMine((current) => [created, ...(current ?? [])])
      setSent(requestTitle(created))
      setBankId('')
      setCardName('')
      setBins([''])
      setNote('')
      setPicked(null)
      setQuery('')
    } catch (err) {
      // The API's validators report every fault at once, so show every one.
      if (err instanceof ApiError) setFaults(err.details ?? [err.message])
      else setFaults(['Something went wrong. Try again.'])
    } finally {
      setBusy(false)
    }
  }, [bankId, bins, cardName, kind, network, note, picked])

  const withdraw = useCallback(async (id: string) => {
    setMine((current) => (current ?? []).filter((request) => request.id !== id))
    await withdrawCardRequest(id).catch(() => {
      // Put it back: the row is still there as far as the server is concerned.
      void fetchMyCardRequests().then(setMine).catch(() => undefined)
    })
  }, [])

  return (
    <Screen glows={GLOWS} className={styles.content}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.back}
          onClick={() => navigate({ kind: 'wallet' })}
          aria-label="Back"
        >
          ←
        </button>
        <div className={styles.heading}>Missing a card?</div>
      </div>

      {!signedIn ? (
        <div className={styles.empty}>
          Sign in to ask for a card. We tie a request to your account so we can tell you what
          happened to it.
          <div>
            <Button variant="compact" onClick={() => navigate({ kind: 'login' })}>
              Sign in
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.tabs} role="tablist" aria-label="What is missing">
            <button
              type="button"
              role="tab"
              aria-selected={kind === 'card'}
              className={kind === 'card' ? styles.tabOn : styles.tab}
              onClick={() => setKind('card')}
            >
              Card isn’t listed
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={kind === 'bin'}
              className={kind === 'bin' ? styles.tabOn : styles.tab}
              onClick={() => setKind('bin')}
            >
              Can’t verify it
            </button>
          </div>

          <div className={styles.form}>
            {kind === 'bin' ? (
              <>
                {pickedCard ? (
                  <div className={styles.pickedRow}>
                    <div>
                      <div className={styles.pickedName}>{pickedCard.name}</div>
                      <div className={styles.pickedIssuer}>{pickedCard.issuer}</div>
                    </div>
                    <button
                      type="button"
                      className={styles.change}
                      onClick={() => setPicked(null)}
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <label className={styles.label} htmlFor="request-card-search">
                      Which card?
                    </label>
                    <input
                      id="request-card-search"
                      className={styles.input}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search a card or bank"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                    {matches.map((card) => (
                      <button
                        key={card.id}
                        type="button"
                        className={styles.match}
                        onClick={() => {
                          setPicked(card.id)
                          setQuery('')
                        }}
                      >
                        <span className={styles.matchName}>{card.name}</span>
                        <span className={styles.matchIssuer}>{card.issuer}</span>
                      </button>
                    ))}
                    {query.trim() && matches.length === 0 ? (
                      <button
                        type="button"
                        className={styles.switchHint}
                        onClick={() => {
                          setKind('card')
                          setCardName(query.trim())
                          setQuery('')
                        }}
                      >
                        Nothing matches “{query.trim()}”. Ask us to add it instead →
                      </button>
                    ) : null}
                  </>
                )}
              </>
            ) : (
              <>
                <label className={styles.label} htmlFor="request-bank">
                  Bank
                </label>
                {/* A list, not a text box. Typing invited three spellings of
                    one issuer into the queue and a brand new bank nobody could
                    check, and the request carried a name where the catalog
                    wanted a row. Picking sends an id instead. A bank we do not
                    carry at all cannot be requested this way -- that is an
                    admin's job, and the note below says so. */}
                <select
                  id="request-bank"
                  className={styles.input}
                  value={bankId}
                  onChange={(e) => setBankId(e.target.value)}
                >
                  <option value="">Pick the bank</option>
                  {banks.map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {bank.name}
                    </option>
                  ))}
                </select>

                <p className={styles.caution}>
                  Only banks we already cover. If yours is missing, say so in the
                  note below and we will look at adding it.
                </p>

                <label className={styles.label} htmlFor="request-name">
                  Card
                </label>
                <input
                  id="request-name"
                  className={styles.input}
                  value={cardName}
                  onChange={(e) => setCardName(e.target.value)}
                  placeholder="Infinia Metal"
                  autoComplete="off"
                  autoCapitalize="words"
                />
              </>
            )}

            <label className={styles.label} htmlFor="request-network">
              Network
            </label>
            <select
              id="request-network"
              className={styles.input}
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
            >
              <option value="">Pick the logo on the card</option>
              {networks.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name}
                </option>
              ))}
            </select>

            <div className={styles.label}>First 6 digits (optional)</div>
            {/* THE ONLY FIELD IN THE APP THAT ASKS SOMEBODY TO READ DIGITS OFF
                THEIR CARD, in an app that also runs a card-verification flow.
                maxLength is 8 so a full card number cannot physically be typed
                in, and the note below says so in words. The API repeats both
                checks and never echoes a rejected value back. */}
            <p className={styles.caution}>
              The first 6 digits only — never your full card number. They tell us which cards a
              bank issues, not which card is yours.
            </p>
            {bins.map((bin, index) => (
              <input
                key={index}
                className={styles.input}
                value={bin}
                inputMode="numeric"
                maxLength={8}
                placeholder="411111"
                aria-label={`BIN prefix ${index + 1}`}
                onChange={(e) => {
                  const next = [...bins]
                  next[index] = e.target.value.replace(/\D/g, '')
                  setBins(next)
                }}
              />
            ))}
            {bins.length < MAX_BIN_FIELDS ? (
              <button
                type="button"
                className={styles.addBin}
                onClick={() => setBins([...bins, ''])}
              >
                + Another prefix
              </button>
            ) : null}

            <label className={styles.label} htmlFor="request-note">
              Anything else (optional)
            </label>
            <textarea
              id="request-note"
              className={styles.textarea}
              value={note}
              maxLength={280}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              placeholder="A link to the card's page helps."
            />

            {faults.length > 0 ? (
              <ul className={styles.faults}>
                {faults.map((fault) => (
                  <li key={fault}>{fault}</li>
                ))}
              </ul>
            ) : null}

            {sent ? <div className={styles.sent}>Sent — we’ll look at {sent}.</div> : null}

            <Button disabled={!ready} onClick={() => void submit()}>
              {busy ? 'Sending…' : 'Send request'}
            </Button>
          </div>

          <div className={styles.listHeading}>Your requests</div>
          {mine === null ? (
            <div className={styles.empty}>Loading…</div>
          ) : mine.length === 0 ? (
            <div className={styles.empty}>Nothing yet.</div>
          ) : (
            mine.map((request) => (
              <div key={request.id} className={styles.request}>
                <div className={styles.requestTop}>
                  <div className={styles.requestName}>{requestTitle(request)}</div>
                  <div
                    className={styles.requestStatus}
                    style={{ color: REQUEST_STATUS_COLOR[request.status] }}
                  >
                    {REQUEST_STATUS_LABEL[request.status]}
                  </div>
                </div>
                <p className={styles.requestNote}>{requestNote(request)}</p>
                {request.status === 'pending' ? (
                  <button
                    type="button"
                    className={styles.withdraw}
                    onClick={() => void withdraw(request.id)}
                  >
                    Withdraw
                  </button>
                ) : null}
              </div>
            ))
          )}
        </>
      )}
    </Screen>
  )
}
