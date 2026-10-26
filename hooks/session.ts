/**
 * What the router keeps for one session, and how it is reported: plain data
 * and pure functions (no `$`), so the hooks module stays about events.
 */
import type { PluginOptions } from 'claude-code'

import {
  PRICES_AS_OF,
  addRequest,
  addTokens,
  emptyLedger,
  money,
  noTokens,
  priceKey,
  priceName,
  tokenCount,
  tokenTotal,
} from './pricing.ts'
import type { Ledger, Tokens } from './pricing.ts'
import { PROFILES, emptyCalibration, familyOf, isEffort, runKey, short } from './router.ts'
import type { Calibration, CapModel, Effort, Outcome, Profile, Task, TopModel } from './router.ts'

export type Source = 'rules' | 'classifier' | 'retry'
export type Status = 'running' | 'done' | 'partial' | 'stuck' | 'unreported' | 'error' | 'stopped' | 'refused'

/** One delegation: what was decided, and what actually happened. */
export type Decision = {
  id: string
  at: number
  task: Task
  category: string
  rung: number
  label: string
  source: Source
  why: string
  /** The model and effort the router (or Claude, explicitly) asked for. */
  requestedModel?: string
  requestedEffort?: string
  /** True when Claude named the effort or the session pins it: never raised. */
  explicitEffort: boolean
  /** The model Claude Code resolved at spawn, then the one each request reported. */
  startModel?: string
  actualModel?: string
  modelsUsed: string[]
  /** The effort the first request actually went out at, and the latest after raises. */
  observedEffort?: Effort
  finalEffort?: Effort
  /** True when Claude Code ran it below the requested effort (an effort cap). */
  capped: boolean
  /** What the subagent would have run on without the router: its parent's model. */
  parentModel?: string
  agentId?: string
  status: Status
  feel?: string
  learned?: Outcome
  raised: number
  ledger: Ledger
}

/** A routed subagent while it runs. */
export type Live = {
  decision: Decision
  adjustable: boolean
  steps: number
  errors: number
  streak: number
  bumps: number
  stepBumped: boolean
  /** Set from the first request: the effort to send, and the ceiling no raise passes. */
  effort?: Effort
  startEffort?: Effort
  ceiling: Effort
  /** Tokens already priced request by request, so a run's total is not counted twice. */
  accounted: Tokens
}

export type Config = {
  profile: Profile
  maxModel: CapModel
  hardestModel: TopModel
  classifier: boolean
  adaptiveEffort: boolean
  learn: boolean
  nudge: boolean
  respectExplicit: boolean
  extraAgents: readonly string[]
}

export type State = {
  config: Config
  enabled: boolean
  profile: Profile
  modelForced: boolean
  effortPinned: boolean
  /** Whether this Claude Code takes `effort` on the Agent call (2.1.292 and later). */
  effortParam: boolean
  /** Claude Code's version, for the export. */
  claudeCode?: string
  calibration: Calibration
  decisions: Decision[]
  byToolUse: Map<string, Decision>
  byPrompt: Map<string, Decision>
  live: Map<string, Live>
  ratings: Map<string, number>
  started: Map<string, number>
  retries: number
  raises: number
  totals: Ledger
  overhead: { ratings: number; ledger: Ledger }
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function readConfig(o: PluginOptions): Config {
  const extra = typeof o.extraAgents === 'string' ? o.extraAgents : ''
  return {
    profile: pick(o.profile, PROFILES, 'balanced'),
    maxModel: pick<CapModel>(o.maxModel, ['opus', 'sonnet', 'haiku'], 'opus'),
    hardestModel: pick<TopModel>(o.hardestModel, ['opus', 'fable'], 'opus'),
    classifier: flag(o.classifier, true),
    adaptiveEffort: flag(o.adaptiveEffort, true),
    learn: flag(o.learn, true),
    nudge: flag(o.nudge, true),
    respectExplicit: flag(o.respectExplicit, true),
    extraAgents: extra
      .split(',')
      .map(name => name.trim())
      .filter(name => name.length > 0),
  }
}

export function newState(config: Config): State {
  return {
    config,
    enabled: true,
    profile: config.profile,
    modelForced: false,
    effortPinned: false,
    effortParam: true,
    calibration: emptyCalibration(),
    decisions: [],
    byToolUse: new Map(),
    byPrompt: new Map(),
    live: new Map(),
    ratings: new Map(),
    started: new Map(),
    retries: 0,
    raises: 0,
    totals: emptyLedger(),
    overhead: { ratings: 0, ledger: emptyLedger() },
  }
}

/** Forgets the session's report (for /clear); running subagents keep being tracked. */
export function resetReport(s: State): void {
  s.decisions = []
  s.started = new Map()
  s.retries = 0
  s.raises = 0
  s.totals = emptyLedger()
  s.overhead = { ratings: 0, ledger: emptyLedger() }
}

/** Prices one request (or an unattributed remainder) of a routed subagent. */
export function record(s: State, d: Decision, model: string | undefined, tokens: Tokens): void {
  if (tokenTotal(tokens) === 0) return
  addRequest(d.ledger, model, tokens, d.parentModel)
  addRequest(s.totals, model, tokens, d.parentModel)
  if (model !== undefined) {
    d.actualModel = model
    if (!d.modelsUsed.includes(model)) d.modelsUsed.push(model)
  }
}

/**
 * A finished delegation's row in the outcome table: its kind of task, how its
 * difficulty was judged, the level it got, and the model and effort it
 * started on (the first model that actually ran, else the one asked for).
 */
export function runKeyOf(d: Decision): string | undefined {
  const model = familyOf(d.modelsUsed[0] ?? d.startModel ?? d.requestedModel) ?? 'other'
  const effort = d.observedEffort ?? (isEffort(d.requestedEffort) ? d.requestedEffort : 'default')
  return runKey({ kind: d.category, via: d.source, level: d.label, model, effort })
}

/** Notes that a routed subagent actually started, for the per-model counts. */
export function noteStarted(s: State, d: Decision): void {
  const family = familyOf(d.startModel ?? d.requestedModel) ?? 'default'
  s.started.set(family, (s.started.get(family) ?? 0) + 1)
}

export function startLive(s: State, d: Decision): Live {
  return {
    decision: d,
    adjustable: s.config.adaptiveEffort && !d.explicitEffort,
    steps: 0,
    errors: 0,
    streak: 0,
    bumps: 0,
    stepBumped: false,
    ceiling: 'max',
    accounted: noTokens(),
  }
}

export const accountedAdd = (run: Live, tokens: Tokens): void => {
  run.accounted = addTokens(run.accounted, tokens)
}

// ---------------------------------------------------------------------------
// Showing it

/** 'haiku', or 'haiku→sonnet' when Claude Code ran it on another model. */
export function shownModel(d: Decision): string {
  const asked = familyOf(d.requestedModel)
  const ran = familyOf(d.actualModel ?? d.startModel)
  if (ran === undefined) return asked ?? 'default'
  return asked !== undefined && asked !== ran ? `${asked}→${ran}` : ran
}

/** 'low', 'low→medium' after raises, '(capped)' when a cap held it below the request. */
export function shownEffort(d: Decision): string {
  const start = d.observedEffort ?? d.requestedEffort
  if (start === undefined) return 'default'
  const end = d.finalEffort ?? start
  return `${end !== start ? `${start}→${end}` : start}${d.capped ? ' (capped)' : ''}`
}

function startedText(s: State): string {
  return [...s.started.entries()].map(([family, count]) => `${family} ${count}`).join(', ')
}

const startedCount = (s: State): number => [...s.started.values()].reduce((a, b) => a + b, 0)

/** The model the session's baseline figures are priced at, when it is one model. */
function baselineName(s: State): string {
  const keys = new Set<string>()
  for (const d of s.decisions) {
    const key = priceKey(d.parentModel)
    if (key !== undefined) keys.add(key)
  }
  const [only] = [...keys]
  return keys.size === 1 && only !== undefined ? priceName(only) : 'the parent models'
}

/** 'est. $0.042 (vs $0.61 on Opus 5.5, 93% less)', or undefined when nothing is priced. */
function costText(s: State): string | undefined {
  const t = s.totals
  if (t.requests === 0 || !t.costKnown) return undefined
  if (!t.baselineKnown || t.baseline === 0) return `est. ${money(t.cost)}`
  const saved = Math.round((1 - t.cost / t.baseline) * 100)
  const delta = saved >= 0 ? `${saved}% less` : `${-saved}% more`
  return `est. ${money(t.cost)} (vs ${money(t.baseline)} on ${baselineName(s)}, ${delta})`
}

export function statusLine(s: State): string | undefined {
  if (!s.enabled) return 'router: off'
  const last = s.decisions[s.decisions.length - 1]
  if (last === undefined) return undefined
  const tasks = startedCount(s)
  const t = s.totals
  const cost =
    t.requests > 0 && t.costKnown
      ? ` · ≈${money(t.cost)}${t.baselineKnown && t.baseline > 0 ? ` (${familyOf(baselineName(s)) ?? 'main'} ≈${money(t.baseline)})` : ''}`
      : ''
  return `router: ${tasks} task${tasks === 1 ? '' : 's'}${cost} · last ${shownModel(last)}/${shownEffort(last)}`
}

/**
 * One line for Claude to read when the person runs /tier-router. Claude Code
 * shows a command's answer under the plugin's name, so it doesn't repeat it.
 */
export function summaryLine(s: State): string {
  const tasks = startedCount(s)
  if (tasks === 0) return 'No subagent tasks routed yet this session.'
  const cost = costText(s)
  return `${tasks} task${tasks === 1 ? '' : 's'} routed this session (${startedText(s)})${cost ? `, ${cost}` : ''}. The full report is shown to the person only.`
}

/** The full report, one entry per line. */
export function reportLines(s: State): string[] {
  const lines: string[] = []
  const c = s.config
  const settings = [
    s.profile,
    `up to ${c.maxModel}${c.hardestModel === 'fable' ? ' (hardest on fable)' : ''}`,
    `classifier ${c.classifier ? 'on' : 'off'}`,
    `effort raises ${c.adaptiveEffort ? 'on' : 'off'}`,
    `learning ${c.learn ? 'on' : 'off'}`,
  ]
  lines.push(`Routing is ${s.enabled ? 'on' : 'off'}: ${settings.join(' · ')}`)
  if (!s.effortParam) lines.push('This Claude Code takes no effort on the Agent call, so effort is sent with each request instead.')
  if (s.modelForced) lines.push('CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set, so only effort is routed.')
  if (s.effortPinned) lines.push('CLAUDE_CODE_EFFORT_LEVEL is set, so only the model is routed.')

  const tasks = startedCount(s)
  if (tasks === 0) {
    lines.push('No subagent tasks routed yet this session.')
  } else {
    lines.push(
      `This session: ${tasks} task${tasks === 1 ? '' : 's'} (${startedText(s)}) · ${s.retries} escalated on retry · ${s.raises} effort raise${s.raises === 1 ? '' : 's'}`,
    )
    const cost = costText(s)
    const t = s.totals
    if (cost !== undefined) {
      const tier = t.overTier > 0 ? ` · ${t.overTier} Haiku request${t.overTier === 1 ? '' : 's'} over 100K tokens` : ''
      lines.push(`Subagent usage: ${tokenCount(tokenTotal(t.tokens))} tokens, ${cost}${tier}`)
    } else if (t.requests > 0) {
      lines.push(`Subagent usage: ${tokenCount(tokenTotal(t.tokens))} tokens (a model outside the price table, so no cost estimate)`)
    }
    if (s.overhead.ratings > 0) {
      const o = s.overhead.ledger
      lines.push(
        `Router overhead: ${s.overhead.ratings} Haiku rating${s.overhead.ratings === 1 ? '' : 's'}, ${tokenCount(tokenTotal(o.tokens))} tokens${o.costKnown ? `, est. ${money(o.cost)}` : ''}`,
      )
    }
    lines.push('Recent, newest first:')
    for (const d of s.decisions.slice(-6).reverse()) {
      const runsOn = `${shownModel(d)}/${shownEffort(d)}`
      const spend =
        d.ledger.requests > 0
          ? ` · ${tokenCount(tokenTotal(d.ledger.tokens))} tok${d.ledger.costKnown ? ` · ${money(d.ledger.cost)}` : ''}`
          : ''
      lines.push(`  ${runsOn.padEnd(20)} ${d.label.padEnd(9)} "${short(d.task.description, 32)}" ${d.status}${spend}`)
      lines.push(`      why: ${d.why}${d.raised > 0 ? `; effort raised ${d.raised}x` : ''}`)
    }
  }

  const learned = Object.entries(s.calibration.bias).filter(([, b]) => Math.abs(b) >= 0.05)
  lines.push(
    learned.length === 0
      ? 'Learned adjustments: none yet.'
      : `Learned adjustments: ${learned.map(([k, b]) => `${k} ${b > 0 ? '+' : ''}${b.toFixed(2)}`).join(', ')}`,
  )
  lines.push(
    `Costs are estimates at API list prices (${PRICES_AS_OF}); on a subscription they show relative usage, not charges. /usage has the authoritative totals.`,
  )
  return lines
}
