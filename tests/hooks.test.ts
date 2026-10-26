import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type AgentInput = {
  tool: string
  description?: string
  prompt?: string
  subagent_type?: string
  model?: string
  effort?: string
}

type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const RATING_USAGE = { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PRESENTATION = { isFullscreen: false, columns: 100 }
const START = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal' as const],
  tools: ['Agent', 'Bash', 'Read'],
  outputStyle: null,
  traits: [],
}

const haiku = (input: number, cacheWrite: number, cacheRead: number, output: number): StepUsage => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
  model: 'claude-haiku-5-5',
})

type Options = {
  rating?: string
  env?: Record<string, string>
  stored?: Record<string, unknown>
  report?: string
  version?: string
  steps?: (StepUsage | null)[]
}

/**
 * Stands in for Claude Code beneath the mod: records each Agent call as the
 * mod rewrote it and answers it with a launch (or, in the foreground, a
 * finished run), fails any Bash call, answers each model request with the
 * next queued usage, and records the effort each request went out at.
 */
function engine(on: On, o: Options = {}) {
  const agents: AgentInput[] = []
  const efforts: unknown[] = []
  const classified: string[] = []
  const logs: string[] = []
  const copies: string[] = []
  const statuses: (string | undefined)[] = []
  const store = new Map<string, unknown>(Object.entries(o.stored ?? {}))
  const steps = [...(o.steps ?? [])]
  let launched = 0

  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  mock.env(on, o.env ?? {})
  mock.clock(on, { now: 1_000_000 })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.version', () => ({ value: { version: o.version ?? '2.1.310', base: o.version ?? '2.1.310' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    copies.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('model.complete', (_, e) => {
    classified.push(e.prompt)
    return o.rating === undefined
      ? { value: { isAnswered: false as const, reason: 'api-error' as const, status: 500, error: 'server_error' as const, usage: RATING_USAGE } }
      : { value: { isAnswered: true as const, text: o.rating, usage: RATING_USAGE } }
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'Agent') return { isError: true as const, result: 'boom', text: 'boom' }
    agents.push(e as AgentInput)
    launched += 1
    if (e.run_in_background === false) {
      return {
        result: {
          status: 'completed',
          agentId: `a${launched}`,
          prompt: e.prompt,
          content: [{ type: 'text', text: o.report ?? 'Done.\nROUTER: done fit' }],
          resolvedModel: 'claude-haiku-5-5',
          totalToolUseCount: 3,
          totalDurationMs: 900,
          totalTokens: 1200,
          usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      } as never
    }
    return {
      result: { status: 'async_launched', agentId: `a${launched}`, description: e.description, prompt: e.prompt, outputFile: '/tmp/out' },
    } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: steps.shift() ?? null }
  })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))

  return { agents, efforts, classified, logs, copies, statuses, store }
}

/** One model request inside subagent `agentId`, at the effort Claude Code resolved. */
async function step($: Engine, agentId: string, effort: Effort) {
  const stream = $.turn.step({ turnId: `t-${agentId}`, index: 0, model: 'claude-haiku-5-5', effort, messageCount: 4, agentId })
  for await (const _ of stream) {
    // drain
  }
  await stream.result
}

async function finish($: Engine, agentId: string, answer: string, usage?: StepUsage) {
  await $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: `t-${agentId}`, agentId, reason: 'answer', usage })
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'tier-router', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

const FIND_TODOS = { tool: 'Agent', description: 'Find TODOs', prompt: 'List TODO comments in src/ with file and line.' } as const
const PAGINATION = {
  tool: 'Agent',
  description: 'Add pagination',
  prompt: 'Add pagination to the /users endpoint in api/routes/users.ts and update its tests.',
} as const

describe('routing', () => {
  test('a trivial search goes to Haiku at low effort, and Claude gets one short line', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)

    const ran = await $.tool.call(FIND_TODOS)

    expect(seen.agents[0]?.model).toBe('haiku')
    expect(seen.agents[0]?.effort).toBe('low')
    expect(seen.agents[0]?.prompt).toContain('ROUTER: <done|partial|stuck> <easy|fit|hard>')
    expect(seen.classified.length).toBe(0)
    expect(ran.context).toEqual(['[tier-router] Haiku, low effort (trivial).'])
  })

  test('an unclear task is rated by Haiku, and a 3 goes to Opus at high effort', async ($, on) => {
    const seen = engine(on, { rating: '3' })
    await $.session.start(START)

    await $.tool.call({
      tool: 'Agent',
      description: 'Review session handling',
      prompt: 'Review how auth/session.ts stores and refreshes tokens and report any security problems you find.',
    })

    expect(seen.classified.length).toBe(1)
    expect(seen.agents[0]?.model).toBe('opus')
    expect(seen.agents[0]?.effort).toBe('high')
  })

  test('when the rating cannot be had, the keyword rules decide', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)

    await $.tool.call(PAGINATION)

    expect(seen.classified.length).toBe(1)
    expect(seen.agents[0]?.model).toBe('sonnet')
    expect(seen.agents[0]?.effort).toBe('medium')
  })

  test('the same unclear task is rated once', async ($, on) => {
    const seen = engine(on, { rating: '2' })
    await $.session.start(START)

    await $.tool.call(PAGINATION)
    await finish($, 'a1', 'Done.\nROUTER: done fit')
    await $.tool.call(PAGINATION)

    expect(seen.classified.length).toBe(1)
    expect(seen.agents[1]?.model).toBe('sonnet')
  })

  test('a model Claude names is kept; the effort is still routed', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)

    await $.tool.call({ ...FIND_TODOS, model: 'opus' })

    expect(seen.agents[0]?.model).toBe('opus')
    expect(seen.agents[0]?.effort).toBe('low')
  })

  test('custom agents and forks are left alone', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)

    await $.tool.call({ tool: 'Agent', description: 'Review diff', prompt: 'Review the diff.', subagent_type: 'my-reviewer' })
    await $.tool.call({ tool: 'Agent', description: 'Side task', prompt: 'Draft tests.', subagent_type: 'fork' })

    expect(seen.agents[0]?.model).toBe(undefined)
    expect(seen.agents[0]?.prompt).toBe('Review the diff.')
    expect(seen.agents[1]?.model).toBe(undefined)
  })

  test('custom agents listed in extraAgents are routed', { options: { extraAgents: 'my-reviewer' } }, async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)

    await $.tool.call({ ...FIND_TODOS, subagent_type: 'my-reviewer' })

    expect(seen.agents[0]?.model).toBe('haiku')
  })

  test('a forced subagent model is respected: only effort is routed', async ($, on) => {
    const seen = engine(on, { env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } })
    await $.session.start(START)

    await $.tool.call(FIND_TODOS)

    expect(seen.agents[0]?.model).toBe(undefined)
    expect(seen.agents[0]?.effort).toBe('low')
  })

  test('a model cap runs hard work on Sonnet at more effort', { options: { maxModel: 'sonnet' } }, async ($, on) => {
    const seen = engine(on, { rating: '3' })
    await $.session.start(START)

    await $.tool.call({ tool: 'Agent', description: 'Review session handling', prompt: 'Review auth/session.ts for security problems.' })

    expect(seen.agents[0]?.model).toBe('sonnet')
    expect(seen.agents[0]?.effort).toBe('xhigh')
  })
})

describe('what actually ran, and what it cost', () => {
  test('each request is priced, Haiku over 100K at its higher rate, against the main model', async ($, on) => {
    const seen = engine(on, { steps: [haiku(2000, 8000, 0, 500), haiku(500, 0, 120_000, 400)] })
    await $.session.start(START)

    await $.tool.call(FIND_TODOS)
    await step($, 'a1', 'low')
    await step($, 'a1', 'low')
    await finish($, 'a1', 'Found 12.\nROUTER: done fit', haiku(2500, 8000, 120_000, 900))

    const report = (await run($, 'share')).text ?? ''
    expect(report).toContain('est. $0.0087 (vs $0.09 on Opus 5.5, 91% less)')
    expect(report).toContain('1 Haiku request over 100K tokens')
    expect(seen.statuses[seen.statuses.length - 1]).toContain('≈$0.0087')
  })

  test('requests the per-request count missed are priced from the run total', async ($, on) => {
    engine(on, { steps: [haiku(500, 0, 120_000, 400)] })
    await $.session.start(START)

    await $.tool.call(FIND_TODOS)
    await step($, 'a1', 'low')
    // The run total also holds an earlier request the hooks never saw.
    await finish($, 'a1', 'Found 12.\nROUTER: done fit', haiku(2500, 8000, 120_000, 900))

    expect((await run($, 'share')).text).toContain('est. $0.0087')
  })

  test('the report shows the model and effort that really ran', async ($, on) => {
    engine(on, { rating: '1', steps: [{ ...haiku(1000, 0, 0, 100), model: 'claude-sonnet-5-5' }] })
    await $.session.start(START)

    await $.tool.call(PAGINATION)
    // Asked for Haiku at medium; it ran on Sonnet (a fallback) at low (a cap).
    await step($, 'a1', 'low')
    await finish($, 'a1', 'Done.\nROUTER: done fit')

    expect((await run($, 'share')).text).toContain('haiku→sonnet/low (capped)')
  })

  test('effort raises never pass a cap', async ($, on) => {
    const seen = engine(on, { rating: '1' })
    await $.session.start(START)

    await $.tool.call(PAGINATION)
    await step($, 'a1', 'low')
    await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' })
    await step($, 'a1', 'low')

    expect(seen.efforts).toEqual(['low', 'low'])
  })

  test('repeated tool errors raise a running subagent\'s effort', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    await $.tool.call(FIND_TODOS)

    await step($, 'a1', 'low')
    await $.tool.call({ tool: 'Bash', command: 'grep -rn TODO src', agentId: 'a1' })
    await $.tool.call({ tool: 'Bash', command: 'grep -rn TODO ./src', agentId: 'a1' })
    await step($, 'a1', 'low')
    await step($, 'a1', 'low')

    expect(seen.efforts).toEqual(['low', 'medium', 'medium'])
    expect((await run($, 'share')).text).toContain('haiku/low→medium')
  })

  test('with CLAUDE_CODE_EFFORT_LEVEL set, the real level is shown and never changed', async ($, on) => {
    const seen = engine(on, { env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } })
    await $.session.start(START)

    await $.tool.call(FIND_TODOS)
    await step($, 'a1', 'high')
    await $.tool.call({ tool: 'Bash', command: 'x', agentId: 'a1' })
    await $.tool.call({ tool: 'Bash', command: 'y', agentId: 'a1' })
    await step($, 'a1', 'high')

    expect(seen.agents[0]?.effort).toBe(undefined)
    expect(seen.efforts).toEqual(['high', 'high'])
    expect(seen.statuses[seen.statuses.length - 1]).toContain('last haiku/high')
  })

  test('on a Claude Code without effort on the Agent call, effort is sent per request', async ($, on) => {
    const seen = engine(on, { version: '2.1.290' })
    await $.session.start(START)

    await $.tool.call(FIND_TODOS)
    await step($, 'a1', 'medium')

    expect(seen.agents[0]?.effort).toBe(undefined)
    expect(seen.efforts).toEqual(['low'])
  })

  test('router overhead counts the Haiku ratings', async ($, on) => {
    engine(on, { rating: '2' })
    await $.session.start(START)

    await $.tool.call(PAGINATION)

    expect((await run($, 'share')).text).toContain('Router overhead: 1 Haiku rating, 901 tokens')
  })
})

describe('learning', () => {
  test('a stuck report is learned, and the re-dispatch escalates to Sonnet', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)

    await $.tool.call(FIND_TODOS)
    await finish($, 'a1', 'I could not tell generated files apart.\nROUTER: stuck hard')
    await $.tool.call(FIND_TODOS)

    expect(seen.agents[1]?.model).toBe('sonnet')
    expect(seen.agents[1]?.effort).toBe('medium')
    const stored = seen.store.get('calibration') as { bias: Record<string, number> }
    expect(stored.bias.search).toBe(0.35)
  })

  test('a foreground run is learned from its result, and a retry after it escalates', async ($, on) => {
    const seen = engine(on, { report: 'Partly done: two files left.\nROUTER: partial fit' })
    await $.session.start(START)
    const job = { ...FIND_TODOS, run_in_background: false }

    await $.tool.call(job)
    await $.tool.call(job)

    expect(seen.agents[1]?.model).toBe('haiku')
    expect(seen.agents[1]?.effort).toBe('medium')
    // Both runs reported partial: two misses, the retry not counted twice.
    const stored = seen.store.get('calibration') as { counts: Record<string, { miss: number }> }
    expect(stored.counts.search?.miss).toBe(2)
    expect((await run($, 'share')).text).toContain('est. $0.0004')
  })

  test('repeating work that came back done is a fresh task, and "easy" makes it cheaper', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    const job = { tool: 'Agent', description: 'Run the tests', prompt: 'Run the unit tests with npm test and report any failures.' } as const

    await $.tool.call(job)
    await finish($, 'a1', 'All 120 pass.\nROUTER: done easy')
    await $.tool.call(job)

    expect(seen.agents[0]?.model).toBe('sonnet')
    expect(seen.agents[1]?.model).toBe('haiku')
    const stored = seen.store.get('calibration') as { counts: Record<string, { miss: number; over: number }> }
    expect(stored.counts.tests?.miss).toBe(0)
    expect(stored.counts.tests?.over).toBe(1)
  })

  test('done but hard is strain: a gentle push up', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)

    await $.tool.call(FIND_TODOS)
    await finish($, 'a1', 'Done, barely.\nROUTER: done hard')

    const stored = seen.store.get('calibration') as { bias: Record<string, number> }
    expect(stored.bias.search).toBe(0.15)
  })

  test('Claude re-sending finished work to a stronger model counts as a miss', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)

    await $.tool.call(FIND_TODOS)
    await finish($, 'a1', 'Found 3.\nROUTER: done fit')
    await $.tool.call({ ...FIND_TODOS, model: 'opus' })

    expect(seen.agents[1]?.model).toBe('opus')
    // The run is counted once, as a miss, in both tallies.
    const stored = seen.store.get('calibration') as {
      counts: Record<string, { ok: number; miss: number }>
      runs: Record<string, { ok: number; miss: number }>
    }
    expect(stored.counts.search).toEqual({ ok: 0, miss: 1, over: 0, strain: 0 })
    expect(stored.runs['search|rules|trivial|haiku|low']).toEqual({ ok: 0, miss: 1, over: 0, strain: 0 })
  })

  test('a retry after an API error stays on the same rung', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)

    await $.tool.call(FIND_TODOS)
    await $.turn.complete({ answer: '', durationMs: 50, isAborted: false, turnId: 't-a1', agentId: 'a1', reason: 'error' })
    await $.tool.call(FIND_TODOS)

    expect(seen.agents[1]?.model).toBe('haiku')
    expect(seen.agents[1]?.effort).toBe('low')
    expect(seen.store.has('calibration')).toBe(false)
  })

  test('learned adjustments carry into a new session', async ($, on) => {
    const seen = engine(on, { stored: { calibration: { version: 1, bias: { search: 0.7 }, counts: {} } } })
    await $.session.start(START)

    await $.tool.call(FIND_TODOS)

    expect(seen.agents[0]?.model).toBe('haiku')
    expect(seen.agents[0]?.effort).toBe('medium')
  })
})

describe('telling Claude, and the person', () => {
  test('the system prompt gains the routing guide while routing is on', async ($, on) => {
    engine(on)
    await $.session.start(START)

    expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).toContain('tier-router:guide')
    expect((await run($, 'off')).text).toContain('off for this session')
    expect((await $.prompt.compose(COMPOSE)).sections.map(s => s.id)).not.toContain('tier-router:guide')
  })

  test('while off, Agent calls pass through untouched', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    await run($, 'off')

    await $.tool.call(FIND_TODOS)

    expect(seen.agents[0]?.model).toBe(undefined)
    expect(seen.agents[0]?.prompt).toBe(FIND_TODOS.prompt)
  })

  test('/tier-router shows the full report in the transcript and gives Claude one line', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    await $.tool.call(FIND_TODOS)

    const out = await run($, '')

    expect(seen.logs.join('\n')).toContain('Routing is on')
    expect(seen.logs.join('\n')).toContain('"Find TODOs"')
    expect(seen.logs.join('\n')).toContain('why:')
    expect(out.text).toContain('1 task routed this session (haiku 1)')
    // Claude Code shows the answer under the plugin's name already.
    expect(out.text?.startsWith('tier-router')).toBe(false)
    expect(out.text).not.toContain('why:')
  })

  test('/tier-router share hands Claude the full report', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    await $.tool.call(FIND_TODOS)

    const out = await run($, 'share')

    expect(out.text).toContain('why:')
    expect(seen.logs.length).toBe(0)
  })

  test('/clear starts the report over', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await $.tool.call(FIND_TODOS)

    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

    expect((await run($, 'share')).text).toContain('No subagent tasks routed yet this session.')
  })

  test('reset forgets what was learned', async ($, on) => {
    const seen = engine(on, { stored: { calibration: { version: 1, bias: { search: 0.7 }, counts: {} } } })
    await $.session.start(START)

    const out = await run($, 'reset')
    await $.tool.call(FIND_TODOS)

    expect(out.text).toContain('Cleared what the router learned')
    expect(seen.store.has('calibration')).toBe(false)
    expect(seen.agents[0]?.effort).toBe('low')
  })

  test('/tier-router export copies outcome counts, never the task', async ($, on) => {
    const seen = engine(on, { steps: [haiku(1000, 0, 0, 100)] })
    await $.session.start(START)
    await $.tool.call(FIND_TODOS)
    await step($, 'a1', 'low')
    await finish($, 'a1', 'Found 12.\nROUTER: done fit')

    const out = await run($, 'export')

    const copied = seen.copies[0] ?? ''
    expect(seen.logs).toEqual([copied])
    const data = JSON.parse(copied) as { tierRouter: string; claudeCode: string; rows: unknown[] }
    expect(data.tierRouter).toBe('0.3.0')
    expect(data.claudeCode).toBe('2.1.310')
    expect(data.rows).toEqual([['search', 'rules', 'trivial', 'haiku', 'low', 1, 0, 0, 0]])
    expect(copied).not.toContain('TODO')
    expect(copied).not.toContain('src/')
    expect(out.text).toContain('on your clipboard')
    expect(out.text).toContain('https://github.com/MrKashiwagi/tier-router/issues/new?template=share-routing-data.yml')
  })

  test('export includes what earlier sessions recorded, and says when there is nothing', async ($, on) => {
    const earlier = {
      version: 1,
      bias: { debug: 0.35 },
      counts: { debug: { ok: 0, miss: 1, over: 0, strain: 0 } },
      runs: { 'debug|classifier|easy|haiku|medium': { ok: 0, miss: 1, over: 0, strain: 0 } },
    }
    const seen = engine(on, { stored: { calibration: earlier } })
    await $.session.start(START)

    await run($, 'export')
    expect(JSON.parse(seen.copies[0] ?? '{}').rows).toEqual([['debug', 'classifier', 'easy', 'haiku', 'medium', 0, 1, 0, 0]])

    await run($, 'reset')
    expect((await run($, 'export')).text).toContain('Nothing to export yet')
    expect(seen.copies.length).toBe(1)
  })

  test('mode switches the profile for the session', async ($, on) => {
    const seen = engine(on, { rating: '2' })
    await $.session.start(START)
    await run($, 'mode quality')

    await $.tool.call(PAGINATION)

    expect(seen.agents[0]?.model).toBe('sonnet')
    expect(seen.agents[0]?.effort).toBe('high')
  })
})
