/**
 * The tier router's decisions, as pure functions: no `$` and no I/O, so the
 * hooks module and the tests share exactly the same logic.
 *
 * Flow: estimate a task's difficulty (keyword rules, or a Haiku rating when
 * the rules are unsure), add what was learned for that kind of task, then
 * read the model and effort off the active profile's ladder. A retry climbs
 * the ladder; a struggling subagent gets its effort raised in place.
 */

export type ModelAlias = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Profile = 'frugal' | 'balanced' | 'quality'
export type CapModel = 'haiku' | 'sonnet' | 'opus'
export type TopModel = 'opus' | 'fable'

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const PROFILES: readonly Profile[] = ['frugal', 'balanced', 'quality']

const RANK: Readonly<Record<ModelAlias, number>> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

/** The family a model id or alias names: 'claude-haiku-5-5' and 'haiku' are both haiku. */
export function familyOf(model: string | undefined): ModelAlias | undefined {
  const m = model === undefined ? null : /(haiku|sonnet|opus|fable)/i.exec(model)
  return m === null ? undefined : ((m[1] ?? '').toLowerCase() as ModelAlias)
}

/** How strong a model is, by family (haiku 0 to fable 3); an unknown model counts as Sonnet. */
export function rankOf(model: string | undefined): number {
  const family = familyOf(model)
  return family === undefined ? 1 : RANK[family]
}

export const effortRank = (effort: Effort): number => EFFORTS.indexOf(effort)

/** Rungs 0-4 are difficulty levels; rung 5 is reached only by escalating a retry. */
export const LABELS = ['trivial', 'easy', 'moderate', 'hard', 'very hard', 'escalated'] as const
export const TOP_RUNG = 5

type Rung = readonly [ModelAlias, Effort]

/** Difficulty rung -> [model, effort], per profile. */
export const LADDERS: Readonly<Record<Profile, readonly Rung[]>> = {
  frugal: [
    ['haiku', 'low'],
    ['haiku', 'low'],
    ['haiku', 'high'],
    ['sonnet', 'high'],
    ['opus', 'high'],
    ['opus', 'xhigh'],
  ],
  balanced: [
    ['haiku', 'low'],
    ['haiku', 'medium'],
    ['sonnet', 'medium'],
    ['opus', 'high'],
    ['opus', 'xhigh'],
    ['opus', 'max'],
  ],
  quality: [
    ['haiku', 'medium'],
    ['sonnet', 'low'],
    ['sonnet', 'high'],
    ['opus', 'xhigh'],
    ['opus', 'max'],
    ['opus', 'max'],
  ],
}

export type Limits = { profile: Profile; maxModel: CapModel; hardestModel: TopModel }
export type Choice = { rung: number; label: string; model: ModelAlias; effort: Effort }

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

export const isEffort = (v: unknown): v is Effort =>
  typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

/** The effort `by` levels above `effort`, stopping at max. */
export function raise(effort: Effort, by = 1): Effort {
  return EFFORTS[clamp(EFFORTS.indexOf(effort) + by, 0, EFFORTS.length - 1)] ?? effort
}

/** The model and effort for a rung, after the model cap and the hardest-task model. */
export function choose(rung: number, limits: Limits): Choice {
  const r = clamp(Math.round(rung), 0, TOP_RUNG)
  const [baseModel, baseEffort] = LADDERS[limits.profile][r] ?? ['sonnet', 'medium']
  let model: ModelAlias = baseModel
  let effort: Effort = baseEffort

  if (RANK[model] > RANK[limits.maxModel]) {
    // Above the cap: run on the capped model, one effort level higher instead.
    model = limits.maxModel
    effort = raise(effort)
  }
  // Fable is an opt-in for the very hardest work, wherever Opus is allowed.
  if (limits.hardestModel === 'fable' && r >= 4 && model === 'opus') {
    model = 'fable'
  }

  return { rung: r, label: LABELS[r] ?? 'moderate', model, effort }
}

/**
 * Where a retry goes: the first rung above `rung` that changes the model or
 * effort, or with `nextModel` (the last run reported it was stuck) the first
 * that changes the model, since more effort rarely unsticks a weaker model.
 */
export function escalate(rung: number, limits: Limits, nextModel = false): Choice {
  const from = choose(rung, limits)
  for (let r = from.rung + 1; r <= TOP_RUNG; r++) {
    const next = choose(r, limits)
    const changed = nextModel
      ? RANK[next.model] > RANK[from.model]
      : next.model !== from.model || next.effort !== from.effort
    if (changed) return next
  }
  if (nextModel) return escalate(rung, limits, false)

  return { ...choose(TOP_RUNG, limits), label: LABELS[TOP_RUNG] }
}

// ---------------------------------------------------------------------------
// Difficulty

export type Task = { description: string; prompt: string; agentType: string }
export type Estimate = { level: number; confident: boolean; why: string }

const TRIVIAL: readonly RegExp[] = [
  /\b(list|find|locate|grep|count|look ?up|search (for|the|through))\b/,
  /\bwhere (is|are|does)\b|\bwhich (files?|functions?|modules?|classes?)\b/,
  /\b(rename|re-?format|format|typos?|sort (the )?imports|bump the version)\b/,
  /\b(summari[sz]e|tl;?dr|extract|read (the |this )?file)\b/,
  /\b(commit message|changelog|boilerplate|scaffold)\b/,
]

const HARD: readonly RegExp[] = [
  /\barchitect\w*|\bsystem design\b|\btrade-?offs?\b|\bdesign (a|an|the) \w+/,
  /\brace conditions?\b|\bdeadlocks?\b|\bconcurren\w*|\bthread[- ]safe\w*/,
  /\bsecurity\b|\bvulnerab\w*|\bexploit\w*|\binjection\b|\bxss\b|\bcsrf\b/,
  /\bperformance\b|\boptimi[sz]\w*|\blatency\b|\bmemory leaks?\b|\bprofiling\b/,
  /\bmigrat\w*|\b(across|throughout) the (whole |entire )?(code ?base|repo\w*|project)\b|\bentire (code ?base|repo\w*|project)\b/,
  /\broot cause\b|\bintermittent\w*|\bflaky\b|\bnon-?deterministic\b/,
  /\balgorithm\w*|\bprove\b|\bproofs?\b|\binvariants?\b/,
  /\bdistributed\b|\bconsensus\b|\bcache invalidation\b/,
]

const MODERATE: readonly RegExp[] = [
  /\bimplement\w*|\badd (a|an|the|support)\b|\bbuild\b|\bcreate\b/,
  /\bfix\w*|\bdebug\w*|\bbugs?\b|\berrors?\b|\bexceptions?\b|\bfailing\b|\bbroken\b|\btraceback\b/,
  /\brefactor\w*|\brestructur\w*|\bclean ?up\b|\brewrite\b/,
  /\btests?\b|\bspecs?\b|\bcoverage\b/,
  /\breview\w*|\baudit\w*/,
]

const FILE =
  /[\w./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|sql|ya?ml|json|toml|md|css|scss|html|vue|svelte)\b/g

const hits = (patterns: readonly RegExp[], text: string): number =>
  patterns.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0)

/**
 * Keyword rules: a level from 0 (trivial) to 4 (very hard), and whether the
 * rules are sure enough to skip asking the classifier.
 */
export function estimate(task: Task): Estimate {
  const text = `${task.description}\n${task.prompt}`.toLowerCase()
  const words = text.split(/\s+/).filter(Boolean).length
  const files = new Set(text.match(FILE) ?? []).size
  const hard = hits(HARD, text)
  const trivial = hits(TRIVIAL, text)
  const moderate = hits(MODERATE, text)

  if (task.agentType === 'Explore') {
    // Claude states a thoroughness for every Explore run.
    if (/very thorough/.test(text)) return { level: 2, confident: true, why: 'Explore, very thorough' }
    if (/\bmedium\b/.test(text)) return { level: 1, confident: true, why: 'Explore, medium' }
    if (/\bquick\b/.test(text)) return { level: 0, confident: true, why: 'Explore, quick' }
  }

  let level = 1.6
  level -= Math.min(1.5, trivial * (hard > 0 ? 0.35 : 0.75))
  level += Math.min(2.4, hard * 0.9)
  level += Math.min(0.8, moderate * 0.3)
  if (words < 25) level -= 0.4
  else if (words > 500) level += 0.8
  else if (words > 200) level += 0.4
  if (files >= 12) level += 0.8
  else if (files >= 5) level += 0.4
  level = clamp(level, 0, 4)

  const why: string[] = []
  if (hard > 0) why.push(`${hard} hard signal${hard > 1 ? 's' : ''}`)
  if (moderate > 0) why.push(`${moderate} moderate`)
  if (trivial > 0) why.push(`${trivial} simple`)
  if (files >= 5) why.push(`${files} files`)
  const reason = why.length > 0 ? why.join(', ') : 'no strong signals'

  if (task.agentType === 'Explore') {
    // Read-only search: rules alone, and never above Sonnet's rung.
    return { level: Math.min(level, 2), confident: true, why: `Explore, ${reason}` }
  }
  if (task.agentType === 'Plan') {
    level = Math.max(level, 2)
  }

  const confident = hard >= 2 || (hard === 0 && trivial > 0 && words < 120 && level <= 1)
  return { level, confident, why: reason }
}

/** The classifier's instructions: one digit back, 0-4. */
export const CLASSIFIER_SYSTEM = [
  'You rate how difficult a delegated software task is, so it can be routed to a cheaper or a stronger AI model.',
  'Reply with a single digit and nothing else.',
  '0 = trivial: look something up, list or search files, rename, reformat, or summarize one short file. No judgment needed.',
  '1 = easy: a small, fully specified change, or a summary of a few files. Little risk.',
  '2 = moderate: ordinary feature work, a bug with a clear error, tests for normal code, a change across a few files.',
  '3 = hard: subtle multi-file changes, unclear root causes, design decisions, security or performance work, or anything where a wrong answer is costly.',
  '4 = very hard: concurrency, novel algorithms, large migrations, or deep debugging that has already failed once.',
  'Rate the work the task requires, not how confidently it is phrased.',
].join('\n')

const CLASSIFIER_CHARS = 5000

export function classifierPrompt(task: Task): string {
  const body = task.prompt.length > CLASSIFIER_CHARS ? `${task.prompt.slice(0, CLASSIFIER_CHARS)}\n[...]` : task.prompt
  return `Agent type: ${task.agentType}\nTask title: ${task.description}\n\nTask:\n${body}`
}

/** The first digit 0-4 in the classifier's reply. */
export function parseLevel(reply: string): number | undefined {
  const m = /[0-4]/.exec(reply)
  return m === null ? undefined : Number(m[0])
}

// ---------------------------------------------------------------------------
// Kinds of task, for learning

const CATEGORIES: readonly (readonly [string, RegExp])[] = [
  ['search', /\b(find|search|locate|grep|list|look ?up|explore|where (is|are))\b/],
  ['tests', /\b(tests?|specs?|coverage|test suite)\b/],
  ['debug', /\b(bugs?|fix\w*|debug\w*|errors?|crash\w*|exceptions?|failing|broken|traceback)\b/],
  ['docs', /\b(docs?|documentation|readme|docstrings?|comments?|changelog)\b/],
  ['review', /\b(review\w*|audit\w*|security|vulnerab\w*)\b/],
  ['refactor', /\b(refactor\w*|restructur\w*|clean ?up|migrat\w*|rewrite)\b/],
  ['design', /\b(design|architect\w*|plan|approach|trade-?offs?)\b/],
  ['implement', /\b(implement\w*|add|create|build|write)\b/],
  ['summarize', /\b(summari[sz]e|explain|describe|overview|read)\b/],
]

export function categorize(task: Task): string {
  if (task.agentType === 'Explore') return 'search'
  if (task.agentType === 'Plan') return 'design'
  const description = task.description.toLowerCase()
  const opening = task.prompt.slice(0, 600).toLowerCase()
  for (const [name, re] of CATEGORIES) if (re.test(description)) return name
  for (const [name, re] of CATEGORIES) if (re.test(opening)) return name
  return 'other'
}

// ---------------------------------------------------------------------------
// Retries

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'you', 'your',
  'its', 'all', 'any', 'not', 'but', 'what', 'when', 'which', 'then', 'than', 'have', 'has', 'should',
  'must', 'can', 'will', 'each', 'only', 'also', 'make', 'sure', 'please', 'task', 'report', 'back',
])

const words = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(w => w.length > 2 && !STOP.has(w)),
  )

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Jaccard similarity of two texts' significant words, 0 to 1. */
export function similarity(a: string, b: string): number {
  const A = words(a)
  const B = words(b)
  if (A.size === 0 || B.size === 0) return 0
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return shared / (A.size + B.size - shared)
}

/** Whether `b` reads as the same job as `a`, re-dispatched. */
export function isSameTask(a: Task, b: Task): boolean {
  if (a.agentType !== b.agentType) return false
  const sameTitle = norm(a.description).length > 0 && norm(a.description) === norm(b.description)
  const overlap = similarity(a.prompt, b.prompt)
  return (sameTitle && overlap >= 0.35) || overlap >= 0.6
}

// ---------------------------------------------------------------------------
// What a subagent reports back

export type Report = { status: 'done' | 'partial' | 'stuck'; feel: 'easy' | 'fit' | 'hard' }

/**
 * A run as a lesson: `miss` (it fell short), `strain` (it got there, but it
 * was hard or needed its effort raised twice), `over` (a strong model found it
 * easy), or `ok`.
 */
export type Outcome = 'ok' | 'miss' | 'over' | 'strain'

const REPORT_LINE = /ROUTER:\s*\**\s*(done|partial|stuck)\b[\s*,;:\-]*(easy|fit|hard)?/gi

/** The last `ROUTER: <status> <feel>` line in a report, if any. */
export function parseReport(text: string): Report | undefined {
  let last: RegExpMatchArray | undefined
  for (const m of text.matchAll(REPORT_LINE)) last = m
  if (last === undefined) return undefined
  const status = (last[1] ?? 'done').toLowerCase() as Report['status']
  const feel = (last[2] ?? 'fit').toLowerCase() as Report['feel']
  return { status, feel }
}

export function outcomeOf(report: Report, model: string | undefined, raises = 0): Outcome {
  if (report.status !== 'done') return 'miss'
  if (raises >= 2 || report.feel === 'hard') return 'strain'
  if (report.feel === 'easy' && raises === 0 && rankOf(model) >= 1) return 'over'
  return 'ok'
}

// ---------------------------------------------------------------------------
// Learning

export type Counts = { ok: number; miss: number; over: number; strain: number }

/**
 * What the router has learned, kept across sessions. `bias` moves a kind of
 * task along the ladder; `counts` tallies outcomes per kind of task; `runs`
 * tallies them per kind of task, estimate, model and effort, keyed by
 * `runKey` (the rows `/tier-router export` shares). `runs` arrived in 0.3.0:
 * an older store reads without it.
 */
export type Calibration = {
  version: 1
  bias: Record<string, number>
  counts: Record<string, Counts>
  runs: Record<string, Counts>
}

const BIAS_MIN = -1
const BIAS_MAX = 1.5
/** Enough for every combination a person's routing realistically produces. */
export const MAX_RUN_ROWS = 300

/**
 * One row of the outcome table: the kind of task, how its difficulty was
 * judged (`rules`, `classifier` or `retry`), the level it was given, and the
 * model family and effort it started on.
 */
export type RunKey = { kind: string; via: string; level: string; model: string; effort: string }

const RUN_PART = /^[a-z][a-z -]{0,23}$/

/** `search|rules|trivial|haiku|low`, or undefined for a part that doesn't fit. */
export function runKey(k: RunKey): string | undefined {
  const parts = [k.kind, k.via, k.level, k.model, k.effort]
  return parts.every(p => RUN_PART.test(p)) ? parts.join('|') : undefined
}

export function parseRunKey(text: string): RunKey | undefined {
  const parts = text.split('|')
  if (parts.length !== 5 || !parts.every(p => RUN_PART.test(p))) return undefined
  const [kind = '', via = '', level = '', model = '', effort = ''] = parts
  return { kind, via, level, model, effort }
}

export const emptyCounts = (): Counts => ({ ok: 0, miss: 0, over: 0, strain: 0 })

/** Adds one outcome; `replaces` takes one away from another, for a run judged again. */
function tally(c: Counts | undefined, outcome: Outcome, replaces?: Outcome): Counts {
  const next = { ...(c ?? emptyCounts()) }
  next[outcome] += 1
  if (replaces !== undefined && replaces !== outcome && next[replaces] > 0) next[replaces] -= 1
  return next
}

/** How each lesson moves a kind of task along the ladder. */
const NUDGE: Readonly<Record<Outcome, (bias: number) => number>> = {
  miss: b => b + 0.35,
  strain: b => b + 0.15,
  over: b => b - 0.2,
  ok: b => b * 0.85,
}

export const emptyCalibration = (): Calibration => ({ version: 1, bias: {}, counts: {}, runs: {} })

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

function readCounts(v: unknown): Counts | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const c = v as Partial<Record<keyof Counts, unknown>>
  return { ok: count(c.ok), miss: count(c.miss), over: count(c.over), strain: count(c.strain) }
}

/** What the store holds, checked; anything unexpected starts fresh. */
export function readCalibration(raw: unknown): Calibration {
  const cal = emptyCalibration()
  if (typeof raw !== 'object' || raw === null) return cal
  const r = raw as { version?: unknown; bias?: unknown; counts?: unknown; runs?: unknown }
  if (r.version !== 1) return cal

  if (typeof r.bias === 'object' && r.bias !== null) {
    for (const [k, v] of Object.entries(r.bias)) {
      if (typeof v === 'number' && Number.isFinite(v)) cal.bias[k] = clamp(v, BIAS_MIN, BIAS_MAX)
    }
  }
  if (typeof r.counts === 'object' && r.counts !== null) {
    for (const [k, v] of Object.entries(r.counts)) {
      const c = readCounts(v)
      if (c !== undefined) cal.counts[k] = c
    }
  }
  if (typeof r.runs === 'object' && r.runs !== null) {
    let rows = 0
    for (const [k, v] of Object.entries(r.runs)) {
      const c = readCounts(v)
      if (c === undefined || parseRunKey(k) === undefined || rows >= MAX_RUN_ROWS) continue
      cal.runs[k] = c
      rows += 1
    }
  }
  return cal
}

/**
 * One lesson for a kind of task. `run` names its row in the outcome table
 * (`runKey`); `replaces` re-judges a run already counted, as when Claude
 * re-sends finished work to a stronger model and an `ok` becomes a `miss`,
 * so the run is counted once. A new row past `MAX_RUN_ROWS` is not added.
 */
export function learn(cal: Calibration, category: string, outcome: Outcome, run?: string, replaces?: Outcome): Calibration {
  const before = cal.bias[category] ?? 0
  let next = clamp(Math.round(NUDGE[outcome](before) * 100) / 100, BIAS_MIN, BIAS_MAX)
  if (Math.abs(next) < 0.05) next = 0

  const runs = { ...cal.runs }
  if (run !== undefined && (Object.hasOwn(runs, run) || Object.keys(runs).length < MAX_RUN_ROWS)) {
    runs[run] = tally(runs[run], outcome, replaces)
  }
  return {
    version: 1,
    bias: { ...cal.bias, [category]: next },
    counts: { ...cal.counts, [category]: tally(cal.counts[category], outcome, replaces) },
    runs,
  }
}

export const biasFor = (cal: Calibration, category: string): number => cal.bias[category] ?? 0

// ---------------------------------------------------------------------------
// Raising effort mid-task

export type Progress = {
  steps: number
  errors: number
  streak: number
  bumps: number
  stepBumped: boolean
  startEffort: Effort
  effort: Effort
}

/** Model requests a run may take at its starting effort before it counts as long. */
export const STEP_BUDGET: Readonly<Record<Effort, number>> = {
  low: 15,
  medium: 30,
  high: 45,
  xhigh: 60,
  max: Number.POSITIVE_INFINITY,
}

export const MAX_RAISES = 2

/** Why a running subagent should get more effort now, or undefined. */
export function bumpReason(p: Progress): string | undefined {
  if (p.bumps >= MAX_RAISES || p.effort === 'max') return undefined
  if (p.streak >= 2) return 'repeated tool errors'
  if (p.errors >= 4) return 'many tool errors'
  if (!p.stepBumped && p.steps > STEP_BUDGET[p.startEffort]) return 'a long run'
  return undefined
}

// ---------------------------------------------------------------------------
// Versions

/** Whether a version string ('2.1.310', '2.1.292-dev') is at least `min`. */
export function versionAtLeast(version: string | undefined, min: readonly [number, number, number]): boolean {
  const m = version === undefined ? null : /(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (m === null) return true
  const have = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0
    const b = min[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}

// ---------------------------------------------------------------------------
// Words

const NAMES: Readonly<Record<string, string>> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }

export const modelName = (m: string): string => NAMES[familyOf(m) ?? m] ?? m

export const short = (s: string, n = 40): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** Appended to a routed subagent's prompt. Kept short: every routed run reads it. */
export function footer(model: string | undefined, effort: string | undefined, label: string): string {
  const who =
    model !== undefined
      ? `${modelName(model)}${effort !== undefined ? ` at ${effort} effort` : ''}`
      : effort !== undefined
        ? `you at ${effort} effort`
        : 'you'
  return [
    '',
    '',
    '---',
    `[tier-router] Routed to ${who} as a ${label} task. If it proves beyond what you can do reliably, stop and report what you found instead of guessing. Keep your final report as short as the task allows.`,
    'End it with one line: ROUTER: <done|partial|stuck> <easy|fit|hard> (whether you finished; how demanding it was for you).',
  ].join('\n')
}

/** What Claude reads beside a routed Agent call's result: one short line. */
export function routedNote(model: string | undefined, effort: string | undefined, label: string, isRetry: boolean): string {
  const runsOn =
    model !== undefined
      ? `${modelName(model)}${effort !== undefined ? `, ${effort} effort` : ''}`
      : `${effort ?? 'default'} effort`
  return `[tier-router] ${runsOn} (${isRetry ? 'escalated retry' : label}).`
}

/** The system prompt section that tells Claude routing is on. */
export function guide(nudge: boolean): string {
  const lines = [
    '# Delegation with tier routing',
    'The tier-router mod picks each subagent\'s model and effort from the task\'s difficulty: simple, well-specified work runs on Haiku at low effort, ordinary work on Sonnet, hard work on Opus. It raises effort for subagents that struggle and learns from results.',
  ]
  if (nudge) {
    lines.push(
      '- Prefer delegating self-contained work that does not need this conversation\'s context: searches, summaries, boilerplate, test runs, mechanical edits. Keep quick or context-heavy work inline, since each subagent starts fresh.',
    )
  }
  lines.push(
    '- Make each delegation prompt stand alone: the goal, the files, and what done means.',
    '- Leave the Agent tool\'s model and effort unset unless the user asks for one.',
    '- Routed reports end with "ROUTER: <done|partial|stuck> <easy|fit|hard>". On partial or stuck, re-dispatch with the same description to escalate; if work reported done falls short, re-dispatch with a stronger model set. Check routed work before relying on it.',
  )
  return lines.join('\n')
}
