import { describe, expect, it } from 'vitest'
import { isBinRuleValue, matchesBinRules } from '../src/modules/networks/binRules'
import type { BinRule } from '../src/modules/networks/binRules'

const glob = (value: string): BinRule => ({ kind: 'glob', value })
const range = (value: string): BinRule => ({ kind: 'range', value })

describe('matchesBinRules', () => {
  it('matches a plain glob prefix', () => {
    expect(matchesBinRules('412345', [glob('4*')])).toBe(true)
    expect(matchesBinRules('512345', [glob('4*')])).toBe(false)
  })

  it('honours a character class', () => {
    const rules = [glob('5[1-5]*')]
    expect(matchesBinRules('512345', rules)).toBe(true)
    expect(matchesBinRules('552345', rules)).toBe(true)
    expect(matchesBinRules('562345', rules)).toBe(false)
    expect(matchesBinRules('502345', rules)).toBe(false)
  })

  it('matches an 8-digit prefix against the same glob', () => {
    expect(matchesBinRules('41234567', [glob('4*')])).toBe(true)
  })

  it('anchors at both ends, so a glob must end in * to match a longer prefix', () => {
    expect(matchesBinRules('508123', [glob('508*')])).toBe(true)
    expect(matchesBinRules('508123', [glob('508')])).toBe(false)
  })

  it('matches a range at both bounds and misses outside them', () => {
    const rules = [range('2221-2720')]
    expect(matchesBinRules('222100', rules)).toBe(true)
    expect(matchesBinRules('272099', rules)).toBe(true)
    expect(matchesBinRules('222099', rules)).toBe(false)
    expect(matchesBinRules('272100', rules)).toBe(false)
  })

  it('accepts a prefix matching any one rule of several', () => {
    const rules = [glob('5[1-5]*'), range('2221-2720')]
    expect(matchesBinRules('222100', rules)).toBe(true)
    expect(matchesBinRules('512345', rules)).toBe(true)
    expect(matchesBinRules('612345', rules)).toBe(false)
  })

  it('matches nothing when there are no rules', () => {
    expect(matchesBinRules('412345', [])).toBe(false)
  })

  /**
   * Every glob the deleted CHECK in 0009 enforced, against a prefix that should
   * pass it. This is the regression guard on the transcription in 0010.
   */
  it('reproduces every rule the old SQL CHECK enforced', () => {
    const cases: Array<[BinRule, string]> = [
      [glob('4*'), '412345'],
      [glob('5[1-5]*'), '531234'],
      [range('2221-2720'), '250012'],
      [glob('3[47]*'), '341234'],
      [glob('3[68]*'), '361234'],
      [glob('30[0-5]*'), '300412'],
      [glob('6[05]*'), '601234'],
      [glob('8[12]*'), '811234'],
      [glob('508*'), '508123'],
      [glob('6011*'), '601100'],
      [glob('64[4-9]*'), '644123'],
      [glob('65*'), '651234'],
      [range('3528-3589'), '355012'],
      [glob('62*'), '621234'],
      [glob('81*'), '811234'],
    ]
    for (const [rule, prefix] of cases) {
      expect(matchesBinRules(prefix, [rule]), `${rule.value} vs ${prefix}`).toBe(true)
    }
  })

  it('never throws for a rule isBinRuleValue accepted', () => {
    for (const value of ['4*', '5[1-5]*', '30[0-5]*', '64[4-9]*', '6011*']) {
      expect(isBinRuleValue('glob', value), value).toBe(true)
      expect(() => matchesBinRules('412345', [{ kind: 'glob', value }])).not.toThrow()
    }
  })
})

describe('isBinRuleValue', () => {
  it('accepts the glob alphabet the CHECK admits', () => {
    for (const value of ['4*', '5[1-5]*', '30[0-5]*', '6011*', '64[4-9]*']) {
      expect(isBinRuleValue('glob', value), value).toBe(true)
    }
  })

  /**
   * The same set migration 0009's CHECK rejects. These are what would turn the
   * glob-to-RegExp translation into an injection if either layer let them by.
   */
  it('rejects every regex metacharacter', () => {
    for (const value of ['4|5*', '4^5*', '4$*', '4+*', '4.*', '4(a)*', '4\\d*', '4 *']) {
      expect(isBinRuleValue('glob', value), value).toBe(false)
    }
  })

  it('requires a range to be two four-digit bounds, low first', () => {
    expect(isBinRuleValue('range', '2221-2720')).toBe(true)
    expect(isBinRuleValue('range', '222-2720')).toBe(false)
    expect(isBinRuleValue('range', '2221_2720')).toBe(false)
    expect(isBinRuleValue('range', 'abcd-efgh')).toBe(false)
    expect(isBinRuleValue('range', '2720-2221')).toBe(false)
  })

  it('accepts every glob the launch catalog actually seeds', () => {
    for (const value of [
      '4*', '5[1-5]*', '3[47]*', '3[68]*', '30[0-5]*', '6[05]*', '8[12]*',
      '508*', '6011*', '64[4-9]*', '65*', '62*', '81*',
    ]) {
      expect(isBinRuleValue('glob', value), value).toBe(true)
    }
  })

  /**
   * Alphabet-valid but structurally broken. Each of these would reach
   * new RegExp() under an alphabet-only check and throw.
   */
  it('rejects a malformed class that would throw at RegExp construction', () => {
    for (const value of ['4[', '4[0', '4[-', '][4', '4[15', '4]', '']) {
      expect(isBinRuleValue('glob', value), value).toBe(false)
    }
  })

  it('rejects a descending range, which throws Range out of order', () => {
    expect(isBinRuleValue('glob', '4[9-0]*')).toBe(false)
    expect(isBinRuleValue('glob', '5[9-0]*')).toBe(false)
  })

  /**
   * The quiet one. ']' first in a class is a literal member in SQLite GLOB but
   * makes an empty, unsatisfiable class in JS -- no throw, just a rule that
   * never matches. An empty class and a nested '[' go the same way.
   */
  it('rejects a class JS and SQLite would read differently', () => {
    for (const value of ['4[]5]*', '4[]', '4[[0-9]']) {
      expect(isBinRuleValue('glob', value), value).toBe(false)
    }
  })

  it('rejects a dash outside a character class', () => {
    expect(isBinRuleValue('glob', '4-*')).toBe(false)
    expect(isBinRuleValue('glob', '-4*')).toBe(false)
  })
})
