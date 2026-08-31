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
})
