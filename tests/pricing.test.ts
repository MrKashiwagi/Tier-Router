import { describe, expect, test } from 'claude-code/testing'

import {
  addRequest,
  emptyLedger,
  money,
  priceKey,
  requestCost,
  subtractTokens,
  tokenCount,
} from '../hooks/pricing.ts'

/** Dollars to seven decimal places, so float noise doesn't fail a comparison. */
const usd = (n: number | undefined): number | undefined => (n === undefined ? undefined : Math.round(n * 1e7) / 1e7)

const STEP_ONE = { input: 2000, cacheWrite: 8000, cacheRead: 0, output: 500 }
const STEP_TWO = { input: 500, cacheWrite: 0, cacheRead: 120_000, output: 400 }

describe('price keys', () => {
  test('ids, dated ids, aliases and display names', async () => {
    expect(priceKey('claude-haiku-5-5')).toBe('haiku-5-5')
    expect(priceKey('claude-opus-5-5-20260601')).toBe('opus-5-5')
    expect(priceKey('claude-opus-5-5[1m]')).toBe('opus-5-5')
    expect(priceKey('Sonnet 5.5')).toBe('sonnet-5-5')
    expect(priceKey('opus')).toBe('opus-5-5')
    expect(priceKey('claude-fable-5-1')).toBe('fable-5-1')
  })

  test('models outside the table get no price', async () => {
    expect(priceKey('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(undefined)
    expect(priceKey('claude-sonnet-5-20260101')).toBe(undefined)
    expect(priceKey('some-other-model')).toBe(undefined)
    expect(priceKey(undefined)).toBe(undefined)
  })
})

describe('request costs', () => {
  test('Haiku under 100K tokens', async () => {
    expect(usd(requestCost('claude-haiku-5-5', STEP_ONE))).toBe(0.00145)
  })

  test('a Haiku request over 100K tokens pays the higher rates', async () => {
    expect(usd(requestCost('claude-haiku-5-5', STEP_TWO))).toBe(0.00725)
  })

  test('Opus has one rate at any length', async () => {
    expect(usd(requestCost('claude-opus-5-5', STEP_TWO))).toBe(0.034)
  })

  test('an unknown model has no cost', async () => {
    expect(requestCost('claude-haiku-4-5', STEP_ONE)).toBe(undefined)
  })
})

describe('ledgers', () => {
  test('requests add up, priced one by one, against a baseline model', async () => {
    const ledger = emptyLedger()
    addRequest(ledger, 'claude-haiku-5-5', STEP_ONE, 'claude-opus-5-5')
    addRequest(ledger, 'claude-haiku-5-5', STEP_TWO, 'claude-opus-5-5')

    expect(usd(ledger.cost)).toBe(0.0087)
    expect(usd(ledger.baseline)).toBe(0.092)
    expect(ledger.requests).toBe(2)
    expect(ledger.overTier).toBe(1)
    expect(ledger.tokens).toEqual({ input: 2500, cacheWrite: 8000, cacheRead: 120_000, output: 900 })
  })

  test('one unpriced request marks the total as unknown', async () => {
    const ledger = emptyLedger()
    addRequest(ledger, 'claude-haiku-4-5', STEP_ONE, 'claude-opus-5-5')
    expect(ledger.costKnown).toBe(false)
    expect(ledger.baselineKnown).toBe(true)
  })

  test('what a run total holds beyond what was already counted', async () => {
    expect(subtractTokens(STEP_ONE, { input: 500, cacheWrite: 9000, cacheRead: 0, output: 100 })).toEqual({
      input: 1500,
      cacheWrite: 0,
      cacheRead: 0,
      output: 400,
    })
  })
})

describe('formatting', () => {
  test('money', async () => {
    expect(money(0)).toBe('$0')
    expect(money(0.0087)).toBe('$0.0087')
    expect(money(0.092)).toBe('$0.09')
    expect(money(12.4)).toBe('$12')
  })

  test('token counts', async () => {
    expect(tokenCount(950)).toBe('950')
    expect(tokenCount(12_345)).toBe('12.3k')
    expect(tokenCount(123_456)).toBe('123k')
    expect(tokenCount(1_234_567)).toBe('1.2M')
  })
})
