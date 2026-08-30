import { useEffect, useState } from 'react'

/** Trails `value` by `delay`, so a fast typist issues one request, not eight. */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return settled
}
