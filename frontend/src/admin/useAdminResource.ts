import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * One read, with its loading and error states and a way to redo it.
 *
 * This is the whole of the console's data layer, on purpose. The Redux store
 * exists for the wallet -- it is persisted wholesale to localStorage on every
 * dispatch and carries a prune listener keyed on the catalog -- and admin rows
 * have no business in that machinery. Nor does a cache: after a write the
 * console must show what the server now holds, which is the opposite of what a
 * cache is for. So every screen owns its reads and calls `reload` after it
 * writes.
 */
export type Resource<T> =
  | { status: 'loading'; data: T | null }
  | { status: 'ready'; data: T }
  | { status: 'error'; data: T | null; message: string }

export type UseResource<T> = Resource<T> & { reload: () => void }

/** What a settled request produced, and which request it was. */
type Settled<T> =
  | { key: string; attempt: number; ok: true; data: T }
  | { key: string; attempt: number; ok: false; message: string }

/**
 * `key` identifies the request: change it and the read re-runs. It is passed
 * explicitly rather than inferred from a dependency array because `load` is a
 * fresh closure on every render, so there is nothing stable to compare.
 */
export function useAdminResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
): UseResource<T> {
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<Settled<T> | null>(null)

  // The loader closes over this render's props, so the effect reads it through
  // a ref rather than depending on it. Declared first so it is up to date
  // before the effect below runs.
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    const controller = new AbortController()

    loadRef
      .current(controller.signal)
      .then((data) => setSettled({ key, attempt, ok: true, data }))
      .catch((err: unknown) => {
        // A superseded request is not a failure. The next one is already out.
        if (err instanceof DOMException && err.name === 'AbortError') return
        setSettled({
          key,
          attempt,
          ok: false,
          message: err instanceof Error ? err.message : 'Something went wrong.',
        })
      })

    return () => controller.abort()
  }, [key, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  // Derived rather than set at the top of the effect: a result belongs to the
  // request that produced it, so anything else in flight reads as loading.
  // Stale rows stay on screen meanwhile, which is what keeps a reload after a
  // write from blanking the table.
  const fresh = settled !== null && settled.key === key && settled.attempt === attempt
  const data = settled?.ok ? settled.data : null

  if (!fresh) return { status: 'loading', data, reload }
  if (settled.ok) return { status: 'ready', data: settled.data, reload }
  return { status: 'error', data, message: settled.message, reload }
}
