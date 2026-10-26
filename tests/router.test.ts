import { describe, expect, test } from 'claude-code/testing'

import {
  bumpReason,
  categorize,
  choose,
  emptyCalibration,
  escalate,
  estimate,
  familyOf,
  footer,
  guide,
  isSameTask,
  learn,
  MAX_RUN_ROWS,
  outcomeOf,
  parseLevel,
  parseReport,
  parseRunKey,
  rankOf,
  readCalibration,
  routedNote,
  runKey,
  versionAtLeast,
} from '../hooks/router.ts'
import type { Limits, Progress, Task } from '../hooks/router.ts'

const BALANCED: Limits = { profile: 'balanced', maxModel: 'opus', hardestModel: 'opus' }
const task = (description: string, prompt: string, agentType = 'general-purpose'): Task => ({
  description,
  prompt,
  agentType,
})

describe('estimate', () => {
  test('a quick search is trivial and needs no classifier', async () => {
    const e = estimate(task('Find TODOs', 'Find all TODO comments under src/ and list each file and line.'))
    expect(Math.round(e.level)).toBe(0)
    expect(e.confident).toBe(true)
  })

  test('an intermittent deadlock is hard, without asking', async () => {
    const e = estimate(
      task('Fix worker deadlock', 'Investigate the intermittent deadlock in the job queue worker, find the root cause and fix it.'),
    )
    expect(Math.round(e.level)).toBeGreaterThanOrEqual(3)
    expect(e.confident).toBe(true)
  })

  test('ordinary feature work is left to the classifier', async () => {
    const e = estimate(task('Add pagination', 'Add pagination to the /users endpoint in api/routes/users.ts and update its tests.'))
    expect(e.confident).toBe(false)
  })

  test('Explore follows the thoroughness Claude asked for', async () => {
    expect(estimate(task('Find auth code', 'quick: where is login handled?', 'Explore')).level).toBe(0)
    expect(estimate(task('Map the API', 'very thorough: map every route and its handler', 'Explore')).level).toBe(2)
  })

  test('Plan never drops below moderate', async () => {
    expect(estimate(task('List files', 'list the files in src', 'Plan')).level).toBeGreaterThanOrEqual(2)
  })
})

describe('ladders', () => {
  test('balanced runs trivial work on Haiku and hard work on Opus', async () => {
    expect(choose(0, BALANCED)).toEqual({ rung: 0, label: 'trivial', model: 'haiku', effort: 'low' })
    expect(choose(2, BALANCED)).toEqual({ rung: 2, label: 'moderate', model: 'sonnet', effort: 'medium' })
    expect(choose(3, BALANCED)).toEqual({ rung: 3, label: 'hard', model: 'opus', effort: 'high' })
    expect(choose(4, BALANCED)).toEqual({ rung: 4, label: 'very hard', model: 'opus', effort: 'xhigh' })
  })

  test('a model cap trades the model for one more level of effort', async () => {
    const capped = choose(3, { ...BALANCED, maxModel: 'sonnet' })
    expect(capped.model).toBe('sonnet')
    expect(capped.effort).toBe('xhigh')
  })

  test('the hardest tasks can go to Fable', async () => {
    expect(choose(4, { ...BALANCED, hardestModel: 'fable' }).model).toBe('fable')
    expect(choose(3, { ...BALANCED, hardestModel: 'fable' }).model).toBe('opus')
  })

  test('a retry climbs to the next rung that changes something', async () => {
    expect(escalate(0, BALANCED)).toEqual({ rung: 1, label: 'easy', model: 'haiku', effort: 'medium' })
    const frugal = escalate(0, { ...BALANCED, profile: 'frugal' })
    expect(frugal.rung).toBe(2)
    expect(frugal.effort).toBe('high')
  })

  test('a stuck run goes to a stronger model, not just more effort', async () => {
    const up = escalate(0, BALANCED, true)
    expect(up.model).toBe('sonnet')
    expect(up.effort).toBe('medium')
  })

  test('the top of the ladder stays at the top', async () => {
    const top = escalate(5, BALANCED)
    expect(top.model).toBe('opus')
    expect(top.effort).toBe('max')
  })

  test('model families from ids and aliases', async () => {
    expect(familyOf('claude-haiku-5-5')).toBe('haiku')
    expect(familyOf('Opus 5.5')).toBe('opus')
    expect(familyOf('gpt')).toBe(undefined)
    expect(rankOf('claude-opus-5-5')).toBeGreaterThan(rankOf('sonnet'))
  })
})

describe('reports and lessons', () => {
  test('the last ROUTER line counts, whatever wraps it', async () => {
    expect(parseReport('ROUTER: partial hard\n...\n**ROUTER: done easy**')).toEqual({ status: 'done', feel: 'easy' })
    expect(parseReport('All good.\n`ROUTER: stuck`')).toEqual({ status: 'stuck', feel: 'fit' })
    expect(parseReport('No line here.')).toBe(undefined)
  })

  test('outcomes', async () => {
    expect(outcomeOf({ status: 'stuck', feel: 'hard' }, 'haiku')).toBe('miss')
    expect(outcomeOf({ status: 'done', feel: 'fit' }, 'haiku')).toBe('ok')
    expect(outcomeOf({ status: 'done', feel: 'easy' }, 'claude-opus-5-5')).toBe('over')
    expect(outcomeOf({ status: 'done', feel: 'easy' }, 'haiku')).toBe('ok')
    expect(outcomeOf({ status: 'done', feel: 'hard' }, 'haiku')).toBe('strain')
    expect(outcomeOf({ status: 'done', feel: 'fit' }, 'sonnet', 2)).toBe('strain')
    expect(outcomeOf({ status: 'done', feel: 'easy' }, 'sonnet', 1)).toBe('ok')
  })

  test('the classifier reply is one digit', async () => {
    expect(parseLevel('3')).toBe(3)
    expect(parseLevel(' Rating: 4.')).toBe(4)
    expect(parseLevel('nine')).toBe(undefined)
  })
})

describe('learning', () => {
  test('two misses move a kind of task up a rung; good fits let it fade', async () => {
    let cal = learn(emptyCalibration(), 'tests', 'miss')
    expect(cal.bias.tests).toBe(0.35)
    cal = learn(cal, 'tests', 'miss')
    expect(cal.bias.tests).toBe(0.7)
    expect(Math.round(1 + (cal.bias.tests ?? 0))).toBe(2)
    cal = learn(cal, 'tests', 'ok')
    expect(cal.bias.tests).toBe(0.6)
    expect(cal.counts.tests).toEqual({ ok: 1, miss: 2, over: 0, strain: 0 })
  })

  test('strain nudges up gently; needless strength pulls down', async () => {
    expect(learn(emptyCalibration(), 'debug', 'strain').bias.debug).toBe(0.15)
    const cal = learn(learn(learn(emptyCalibration(), 'docs', 'over'), 'docs', 'over'), 'docs', 'over')
    expect(Math.round(3 + (cal.bias.docs ?? 0))).toBe(2)
  })

  test('a damaged or older store is read safely', async () => {
    expect(readCalibration('nonsense')).toEqual(emptyCalibration())
    expect(readCalibration({ version: 1, bias: { a: 9, b: 'x' }, counts: {} }).bias).toEqual({ a: 1.5 })
    expect(readCalibration({ version: 1, bias: {}, counts: { t: { ok: 2, miss: 1, over: 0 } } }).counts.t).toEqual({
      ok: 2,
      miss: 1,
      over: 0,
      strain: 0,
    })
    // A 0.2 store has no outcome table.
    expect(readCalibration({ version: 1, bias: { search: 0.35 }, counts: {} }).runs).toEqual({})
  })

  test('outcome rows are named by kind, estimate, model and effort', async () => {
    const key = runKey({ kind: 'search', via: 'rules', level: 'very hard', model: 'haiku', effort: 'low' })
    expect(key).toBe('search|rules|very hard|haiku|low')
    expect(parseRunKey(key ?? '')).toEqual({ kind: 'search', via: 'rules', level: 'very hard', model: 'haiku', effort: 'low' })
    // Nothing free-form fits a row's name, so no task text can reach the table.
    expect(runKey({ kind: 'Fix auth.ts', via: 'rules', level: 'easy', model: 'haiku', effort: 'low' })).toBe(undefined)
    expect(parseRunKey('search|rules|easy|haiku')).toBe(undefined)
  })

  test('a run Claude judges again is moved, not counted twice', async () => {
    const key = 'search|rules|trivial|haiku|low'
    let cal = learn(emptyCalibration(), 'search', 'ok', key)
    cal = learn(cal, 'search', 'miss', key, 'ok')
    expect(cal.counts.search).toEqual({ ok: 0, miss: 1, over: 0, strain: 0 })
    expect(cal.runs[key]).toEqual({ ok: 0, miss: 1, over: 0, strain: 0 })
    // Never below zero, even for a run that was not counted the first time.
    expect(learn(emptyCalibration(), 'docs', 'miss', key, 'ok').runs[key]).toEqual({ ok: 0, miss: 1, over: 0, strain: 0 })
  })

  test('the outcome table is read back safely and stays bounded', async () => {
    const stored = { version: 1, bias: {}, counts: {}, runs: { 'search|rules|trivial|haiku|low': { ok: 3 }, junk: { ok: 9 } } }
    expect(readCalibration(stored).runs).toEqual({ 'search|rules|trivial|haiku|low': { ok: 3, miss: 0, over: 0, strain: 0 } })

    let full = emptyCalibration()
    const kinds = 'abcdefghijklmnopqrstuvwxyz'
    for (let i = 0; Object.keys(full.runs).length < MAX_RUN_ROWS; i++) {
      full = learn(full, 'search', 'ok', `k${kinds[i % 26]}${kinds[Math.floor(i / 26) % 26]}|rules|easy|haiku|low`)
    }
    const known = Object.keys(full.runs)[0] ?? ''
    const after = learn(learn(full, 'search', 'ok', 'zz|rules|easy|haiku|low'), 'search', 'ok', known)
    expect(Object.keys(after.runs).length).toBe(MAX_RUN_ROWS)
    expect(after.runs[known]?.ok).toBe(2)
  })

  test('kinds of task', async () => {
    expect(categorize(task('Write unit tests', 'cover the parser'))).toBe('tests')
    expect(categorize(task('Look into it', 'Fix the crash in the importer'))).toBe('debug')
    expect(categorize(task('anything', 'anything', 'Explore'))).toBe('search')
  })
})

describe('retries', () => {
  test('the same job re-dispatched is a retry; a new job with a reused title is not', async () => {
    const first = task('Fix login bug', 'Fix the login redirect loop in auth/session.ts when the token expires.')
    const again = task('Fix login bug', 'Fix the login redirect loop in auth/session.ts; the token expiry path still loops.')
    const other = task('Fix login bug', 'Update the README badges and the changelog.')
    expect(isSameTask(first, again)).toBe(true)
    expect(isSameTask(first, other)).toBe(false)
    expect(isSameTask(first, { ...again, agentType: 'Explore' })).toBe(false)
  })
})

describe('raising effort', () => {
  const progress = (p: Partial<Progress>): Progress => ({
    steps: 1,
    errors: 0,
    streak: 0,
    bumps: 0,
    stepBumped: false,
    startEffort: 'low',
    effort: 'low',
    ...p,
  })

  test('repeated tool errors raise effort', async () => {
    expect(bumpReason(progress({ streak: 2, errors: 2 }))).toBe('repeated tool errors')
  })

  test('a long run raises effort once', async () => {
    expect(bumpReason(progress({ steps: 16 }))).toBe('a long run')
    expect(bumpReason(progress({ steps: 40, stepBumped: true }))).toBe(undefined)
  })

  test('never more than twice, never past max', async () => {
    expect(bumpReason(progress({ streak: 5, bumps: 2 }))).toBe(undefined)
    expect(bumpReason(progress({ streak: 5, effort: 'max' }))).toBe(undefined)
  })
})

describe('versions', () => {
  test('release and development versions', async () => {
    expect(versionAtLeast('2.1.310', [2, 1, 292])).toBe(true)
    expect(versionAtLeast('2.1.292-dev', [2, 1, 292])).toBe(true)
    expect(versionAtLeast('2.1.290', [2, 1, 292])).toBe(false)
    expect(versionAtLeast('3.0.0', [2, 1, 292])).toBe(true)
    expect(versionAtLeast('unknown', [2, 1, 292])).toBe(true)
  })
})

describe('words', () => {
  test('the footer asks for the ROUTER line and a short report', async () => {
    const text = footer('haiku', 'low', 'trivial')
    expect(text).toContain('Routed to Haiku at low effort as a trivial task')
    expect(text).toContain('as short as the task allows')
    expect(text).toContain('ROUTER: <done|partial|stuck> <easy|fit|hard>')
  })

  test('Claude gets one short line per routed call', async () => {
    expect(routedNote('haiku', 'low', 'trivial', false)).toBe('[tier-router] Haiku, low effort (trivial).')
    expect(routedNote('sonnet', 'medium', 'easy', true)).toBe('[tier-router] Sonnet, medium effort (escalated retry).')
  })

  test('the guide nudges delegation only when asked to', async () => {
    expect(guide(true)).toContain('Prefer delegating')
    expect(guide(false)).not.toContain('Prefer delegating')
  })
})
