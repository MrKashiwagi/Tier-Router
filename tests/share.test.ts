import { describe, expect, test } from 'claude-code/testing'

import { emptyCalibration, learn } from '../hooks/router.ts'
import { EXPORT_COLUMNS, exportRows, exportText, hasResults } from '../hooks/share.ts'

const META = { tierRouter: '0.3.0', claudeCode: '2.1.311', profile: 'balanced' }

describe('export', () => {
  test('it holds counts per kind, estimate, model and effort, and what was learned', async () => {
    let cal = learn(emptyCalibration(), 'search', 'ok', 'search|rules|trivial|haiku|low')
    cal = learn(cal, 'search', 'ok', 'search|rules|trivial|haiku|low')
    cal = learn(cal, 'debug', 'miss', 'debug|classifier|easy|haiku|medium')

    const out = JSON.parse(exportText(cal, META)) as Record<string, unknown>

    expect(Object.keys(out)).toEqual(['tierRouter', 'claudeCode', 'profile', 'learned', 'kinds', 'columns', 'rows'])
    expect(out.columns).toEqual([...EXPORT_COLUMNS])
    expect(out.rows).toEqual([
      ['search', 'rules', 'trivial', 'haiku', 'low', 2, 0, 0, 0],
      ['debug', 'classifier', 'easy', 'haiku', 'medium', 0, 1, 0, 0],
    ])
    expect(out.kinds).toEqual({ search: [2, 0, 0, 0], debug: [0, 1, 0, 0] })
    expect(out.learned).toEqual({ debug: 0.35 })
  })

  test('a long export keeps its most-run rows and says how many it left out', async () => {
    let cal = emptyCalibration()
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    for (let i = 0; i < 60; i++) {
      const key = `k${letters[i % 26]}${letters[Math.floor(i / 26)]}|rules|easy|haiku|low`
      for (let n = 0; n <= i % 5; n++) cal = learn(cal, 'search', 'ok', key)
    }

    const text = exportText(cal, META, 900)
    const out = JSON.parse(text) as { rows: unknown[][]; omitted?: number }

    expect(text.length <= 900).toBe(true)
    expect(out.omitted ?? 0).toBeGreaterThan(0)
    expect((out.omitted ?? 0) + out.rows.length).toBe(60)
    expect(out.rows[0]?.[5]).toBe(5)
  })

  test('the most-run rows come first', async () => {
    let cal = learn(emptyCalibration(), 'docs', 'ok', 'docs|rules|easy|haiku|low')
    cal = learn(cal, 'tests', 'ok', 'tests|rules|moderate|sonnet|medium')
    cal = learn(cal, 'tests', 'miss', 'tests|rules|moderate|sonnet|medium')
    expect(exportRows(cal).map(r => r[0])).toEqual(['tests', 'docs'])
  })

  test('nothing on record means nothing to export', async () => {
    expect(hasResults(emptyCalibration())).toBe(false)
    expect(hasResults(learn(emptyCalibration(), 'docs', 'ok'))).toBe(true)
  })
})
