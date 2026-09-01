import { describe, expect, it } from 'vitest'
import { validateHandleInput } from '../src/modules/users/validate'

/** Pure -- no Worker, no database. */

function errorsFor(body: unknown): string[] {
  const result = validateHandleInput(body)
  return result.ok ? [] : result.errors
}

function valueFor(body: unknown): string | undefined {
  const result = validateHandleInput(body)
  return result.ok ? result.value : undefined
}

describe('validateHandleInput', () => {
  it('accepts a well-formed handle', () => {
    expect(valueFor({ handle: 'arjun_k' })).toBe('arjun_k')
    expect(valueFor({ handle: 'a1b2c3' })).toBe('a1b2c3')
  })

  it('normalises case and surrounding whitespace', () => {
    expect(valueFor({ handle: '  ArjunK  ' })).toBe('arjunk')
  })

  it('rejects a body that is not an object', () => {
    expect(errorsFor('arjun').join(' ')).toMatch(/JSON object/)
  })

  it('rejects a missing or non-string handle', () => {
    expect(errorsFor({}).length).toBeGreaterThan(0)
    expect(errorsFor({ handle: 42 }).length).toBeGreaterThan(0)
  })

  it('rejects handles outside the length bounds', () => {
    expect(errorsFor({ handle: 'ab' }).join(' ')).toMatch(/3 to 20/)
    expect(errorsFor({ handle: 'x'.repeat(21) }).join(' ')).toMatch(/3 to 20/)
  })

  it('rejects characters outside the alphabet', () => {
    for (const bad of ['has-dash', 'has space', 'dot.dot', 'emoji🙂x']) {
      expect(errorsFor({ handle: bad }).length, bad).toBeGreaterThan(0)
    }
  })

  it('rejects a reserved handle', () => {
    for (const reserved of ['admin', 'api', 'www', 'health']) {
      expect(errorsFor({ handle: reserved }).join(' '), reserved).toMatch(/reserved/i)
    }
  })

  it('rejects a reserved handle regardless of case', () => {
    expect(errorsFor({ handle: 'ADMIN' }).join(' ')).toMatch(/reserved/i)
  })
})
