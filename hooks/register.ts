/**
 * tier-router: routes each subagent task Claude delegates to Haiku, Sonnet or
 * Opus by difficulty, sets its effort level, raises effort while a subagent
 * struggles, learns from what subagents report back, and keeps an honest
 * account of what ran and what it cost.
 *
 * Hooks, in the order a delegation meets them:
 *   tool.call (Agent)  decide model + effort, rewrite the call, tell Claude
 *   agent.spawn        the new subagent's id, its resolved model, its parent's model
 *   turn.start         the same id, if the spawn hook has not seen it yet
 *   tool.call (any)    count a routed subagent's tool errors
 *   turn.step          observe the real effort, raise it if needed, price the request
 *   turn.complete      price what is left, read the ROUTER line, learn from it
 * plus prompt.compose (tells Claude routing is on), session.end (/clear
 * resets the report) and /tier-router, whose `export` puts an anonymized
 * summary of results on the clipboard for the person to share if they choose.
 *
 * It reads no files, runs no processes and makes no network requests. Run
 * `claude plugin validate` on this folder to see every call it makes.
 */
import type { EngineInterface, Register } from 'claude-code'

import { addRequest, emptyLedger, noTokens, subtractTokens, toTokens } from './pricing.ts'
import type { Tokens, UsageLike } from './pricing.ts'
import {
  CLASSIFIER_SYSTEM,
  PROFILES,
  biasFor,
  bumpReason,
  categorize,
  choose,
  clamp,
  classifierPrompt,
  effortRank,
  emptyCalibration,
  escalate,
  estimate,
  footer,
  guide,
  isEffort,
  isSameTask,
  learn,
  modelName,
  outcomeOf,
  parseLevel,
  parseReport,
  raise,
  rankOf,
  readCalibration,
  routedNote,
  short,
  versionAtLeast,
} from './router.ts'
import type { Choice, Effort, Limits, Outcome, Task } from './router.ts'
import {
  accountedAdd,
  newState,
  noteStarted,
  readConfig,
  record,
  reportLines,
  resetReport,
  runKeyOf,
  shownEffort,
  shownModel,
  startLive,
  statusLine,
  summaryLine,
} from './session.ts'
import type { Decision, Live, Source, State } from './session.ts'
import { SHARE_URL, TIER_ROUTER_VERSION, exportText, hasResults } from './share.ts'

const STORE_KEY = 'calibration'
const BUILT_IN_TYPES = ['general-purpose', 'claude', 'Explore', 'Plan']
const RETRY_WINDOW_MS = 45 * 60 * 1000
const KEEP_DECISIONS = 40
const KEEP_RATINGS = 200
/** The first Claude Code that takes `effort` on the Agent call. */
const EFFORT_PARAM_SINCE = [2, 1, 292] as const
const USAGE = '[status | share | export | on | off | mode frugal|balanced|quality | reset]'

function limitsOf(s: State): Limits {
  return { profile: s.profile, maxModel: s.config.maxModel, hardestModel: s.config.hardestModel }
}

function isRoutable(s: State, type: string): boolean {
  return BUILT_IN_TYPES.includes(type) || s.config.extraAgents.includes(type)
}

type AgentRecord = { agentId?: string; status?: string; text?: string; tokens: Tokens; resolvedModel?: string }

/** The fields of an Agent tool result this mod reads, whatever its variant. */
function agentRecord(result: unknown): AgentRecord {
  if (typeof result !== 'object' || result === null) return { tokens: noTokens() }
  const o = result as Record<string, unknown>
  const text = Array.isArray(o.content)
    ? o.content
        .map(block => {
          const t = typeof block === 'object' && block !== null ? (block as { text?: unknown }).text : undefined
          return typeof t === 'string' ? t : ''
        })
        .join('\n')
    : undefined
  return {
    agentId: typeof o.agentId === 'string' ? o.agentId : undefined,
    status: typeof o.status === 'string' ? o.status : undefined,
    text,
    tokens: toTokens(typeof o.usage === 'object' && o.usage !== null ? (o.usage as UsageLike) : undefined),
    resolvedModel: typeof o.resolvedModel === 'string' ? o.resolvedModel : undefined,
  }
}

function showStatus($: EngineInterface, s: State): void {
  $.ui.status(statusLine(s))
}

/**
 * Records a lesson, re-reading the store first so parallel sessions don't
 * clobber each other. `replaces` re-judges a run already recorded.
 */
async function remember($: EngineInterface, s: State, d: Decision, outcome: Outcome, replaces?: Outcome): Promise<void> {
  if (!s.config.learn) return
  s.calibration = learn(readCalibration(await $.store.get(STORE_KEY)), d.category, outcome, runKeyOf(d), replaces)
  await $.store.set(STORE_KEY, s.calibration)
}

/** A Haiku rating of the task, 0-4, or undefined when it could not be had. Repeats are not re-rated. */
async function classify($: EngineInterface, s: State, task: Task): Promise<number | undefined> {
  const key = `${task.agentType}\n${task.description}\n${task.prompt}`
  const cached = s.ratings.get(key)
  if (cached !== undefined) return cached

  const reply = await $.model.complete({
    model: 'haiku',
    system: CLASSIFIER_SYSTEM,
    prompt: classifierPrompt(task),
    maxTokens: 400,
    effort: 'low',
    timeoutMs: 8000,
  })
  s.overhead.ratings += 1
  addRequest(s.overhead.ledger, 'haiku', toTokens(reply.usage))

  const level = reply.isAnswered ? parseLevel(reply.text) : undefined
  if (level !== undefined) {
    s.ratings.set(key, level)
    if (s.ratings.size > KEEP_RATINGS) {
      const oldest = s.ratings.keys().next().value
      if (oldest !== undefined) s.ratings.delete(oldest)
    }
  }
  return level
}

/** The most recent finished delegation that this task repeats, within the window. */
function findRetry(s: State, task: Task, now: number): Decision | undefined {
  for (let i = s.decisions.length - 1; i >= 0; i--) {
    const d = s.decisions[i]
    if (d === undefined) continue
    if (now - d.at > RETRY_WINDOW_MS) break
    if (d.status === 'running' || d.status === 'refused') continue
    if (isSameTask(d.task, task)) return d
  }
  return undefined
}

/** Ties a delegation to the subagent that runs it, once. */
function bind(s: State, d: Decision, agentId: string, startModel?: string): void {
  if (d.agentId !== undefined) return
  d.agentId = agentId
  d.startModel ??= startModel
  noteStarted(s, d)
  if (!s.live.has(agentId)) s.live.set(agentId, startLive(s, d))
}

/** The run's first request shows the effort Claude Code really used. */
function observeEffort(s: State, run: Live, effort: Effort): void {
  const d = run.decision
  run.startEffort = effort
  run.effort = effort
  d.observedEffort = effort
  d.finalEffort = effort

  const requested = d.requestedEffort
  if (!isEffort(requested)) return
  if (s.effortParam && effortRank(effort) < effortRank(requested)) {
    // Run below what was asked: an effort cap. Raises never pass it.
    run.ceiling = effort
    d.capped = true
  } else if (!s.effortParam && run.adjustable) {
    // This Claude Code takes no effort on the Agent call: send it per request instead.
    run.startEffort = requested
    run.effort = requested
    d.observedEffort = requested
    d.finalEffort = requested
  }
}

/** Closes out a delegation once its subagent's run ends. */
async function settle($: EngineInterface, s: State, d: Decision, reason: string, answer: string): Promise<void> {
  if (d.status !== 'running') return
  if (reason === 'error') {
    d.status = 'error'
    return
  }
  if (reason === 'aborted') {
    d.status = 'stopped'
    return
  }

  const report = parseReport(answer)
  if (report === undefined) {
    d.status = 'unreported'
    return
  }

  d.status = report.status
  d.feel = report.feel
  const outcome = outcomeOf(report, d.actualModel ?? d.startModel ?? d.requestedModel, d.raised)
  d.learned = outcome
  await remember($, s, d, outcome)

  if (report.status !== 'done') {
    $.ui.toast(
      `${modelName(d.actualModel ?? d.requestedModel ?? 'the subagent')} reported ${report.status} on "${short(d.task.description, 32)}". A re-dispatch escalates it.`,
    )
  }
}

export const register: Register = (on, options) => {
  // Lost on a reload of the mod, which only happens while developing it.
  const s: State = newState(readConfig(options))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tier-router',
      description: 'Show or change how subagent tasks are routed to Haiku, Sonnet and Opus',
      argumentHint: USAGE,
    })
    s.calibration = readCalibration(await $.store.get(STORE_KEY))
    s.modelForced = (await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')) === '1'
    const pinned = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
    s.effortPinned = pinned !== undefined && pinned !== '' && pinned !== 'auto'
    const version = await $.session.version()
    s.claudeCode = version.version
    s.effortParam = versionAtLeast(version.base ?? version.version, EFFORT_PARAM_SINCE)

    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear starts a new conversation: start the report over too.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') resetReport(s)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Tell Claude routing is on, so it delegates well. The text changes only
  // when routing is switched on or off, which keeps the prompt cache warm.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!s.enabled || e.traits.includes('bare') || !e.tools.includes('Agent')) return composed

    return {
      sections: [
        ...composed.sections,
        { id: 'tier-router:guide', text: guide(s.config.nudge), scope: 'session' as const },
      ],
    }
  }).catch(($, e, next) => next(e))

  // The routing decision: every Agent call Claude makes, before it runs.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = e.subagent_type ?? 'general-purpose'
    // Forks inherit the parent's model and cache; named agents may be long-lived
    // teammates; remote agents run elsewhere; custom types keep their own models.
    if (!s.enabled || !isRoutable(s, type) || e.name !== undefined || e.isolation === 'remote') {
      return next(e)
    }

    const now = await $.clock.now()
    const task: Task = { description: e.description, prompt: e.prompt, agentType: type }
    const category = categorize(task)

    // 1. How hard is it?
    const rules = estimate(task)
    let level = rules.level
    let source: Source = 'rules'
    let why = rules.why
    if (!rules.confident && s.config.classifier) {
      const rated = await classify($, s, task)
      if (rated !== undefined) {
        level = type === 'Plan' ? Math.max(rated, 2) : rated
        source = 'classifier'
        why = `rated ${rated} by Haiku`
      }
    }

    // 2. Plus what was learned for this kind of task.
    const bias = s.config.learn ? biasFor(s.calibration, category) : 0
    let choice: Choice = choose(clamp(Math.round(level + bias), 0, 4), limitsOf(s))
    if (bias !== 0) why += `; learned ${bias > 0 ? '+' : ''}${bias.toFixed(2)} for ${category}`

    // 3. Re-dispatches. Work that came back partial or stuck climbs the ladder.
    // Work that came back done is a fresh task (re-running the tests after a
    // fix, say), unless Claude now asks for a stronger model: then Claude
    // judged the earlier result short, and that is learned as a miss.
    const previous = findRetry(s, task, now)
    if (previous !== undefined) {
      if (previous.status === 'partial' || previous.status === 'stuck') {
        const up = escalate(previous.rung, limitsOf(s), previous.status === 'stuck')
        if (up.rung > choice.rung) choice = up
        source = 'retry'
        why = `retry after ${shownModel(previous)}/${shownEffort(previous)} ended ${previous.status}`
        s.retries += 1
      } else if (
        (previous.status === 'done' || previous.status === 'unreported') &&
        e.model !== undefined &&
        rankOf(e.model) > rankOf(previous.actualModel ?? previous.startModel ?? previous.requestedModel) &&
        previous.learned !== 'miss'
      ) {
        const judged = previous.learned
        previous.learned = 'miss'
        await remember($, s, previous, 'miss', judged)
        why += `; Claude asked for ${e.model} after ${shownModel(previous)} ended ${previous.status}`
      }
    }

    // 4. Claude's own explicit choices, and the session's forced settings, win.
    const keepModel = (s.config.respectExplicit && e.model !== undefined) || s.modelForced
    const keepEffort = (s.config.respectExplicit && e.effort !== undefined) || s.effortPinned
    const model = keepModel ? e.model : choice.model
    const effort = keepEffort ? e.effort : choice.effort
    const prompt = e.prompt + footer(model, effort, choice.label)

    const decision: Decision = {
      id: e.tool_use_id,
      at: now,
      task,
      category,
      rung: choice.rung,
      label: choice.label,
      source,
      why,
      requestedModel: model,
      requestedEffort: effort,
      explicitEffort: keepEffort,
      modelsUsed: [],
      capped: false,
      // Without the router, a subagent runs on its parent's model. The spawn
      // hook overwrites this with Claude Code's exact id for the parent.
      parentModel: e.agentId === undefined ? await $.session.model() : undefined,
      status: 'running',
      raised: 0,
      ledger: emptyLedger(),
    }
    s.decisions.push(decision)
    if (s.decisions.length > KEEP_DECISIONS) s.decisions.splice(0, s.decisions.length - KEEP_DECISIONS)
    s.byToolUse.set(e.tool_use_id, decision)
    s.byPrompt.set(prompt, decision)
    showStatus($, s)

    const ran = await next({
      ...e,
      prompt,
      ...(keepModel ? {} : { model: choice.model }),
      // Before 2.1.292 the Agent call takes no effort; turn.step sends it instead.
      ...(keepEffort || !s.effortParam ? {} : { effort: choice.effort }),
    })
    s.byToolUse.delete(e.tool_use_id)
    s.byPrompt.delete(prompt)

    if (ran.deny !== undefined) {
      decision.status = 'refused'
      return ran
    }
    if (ran.isError === true) {
      decision.status = 'error'
      return ran
    }

    const result = agentRecord(ran.result)
    if (result.agentId !== undefined) bind(s, decision, result.agentId, result.resolvedModel)

    if (result.status === 'completed') {
      // A foreground run has ended by now; finish it here if turn.complete didn't.
      const run = result.agentId === undefined ? undefined : s.live.get(result.agentId)
      if (decision.status === 'running') {
        record(s, decision, result.resolvedModel, subtractTokens(result.tokens, run?.accounted ?? noTokens()))
        await settle($, s, decision, 'answer', result.text ?? '')
      }
      if (result.agentId !== undefined) s.live.delete(result.agentId)
    }
    showStatus($, s)

    return {
      ...ran,
      context: [...(ran.context ?? []), routedNote(model, effort, choice.label, source === 'retry')],
    }
  }).catch(($, e, next) => next(e))

  // The subagent's id as it starts, the model Claude Code resolved for it, and
  // its parent's exact model (the baseline its costs are compared with).
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const decision = s.byToolUse.get(e.tool_use_id)
    if (decision === undefined || started.agentId === undefined) return started
    if (e.fork || e.isTeammate === true || e.resume !== undefined || e.workflow !== undefined) return started

    decision.parentModel = e.parentModel
    bind(s, decision, started.agentId, started.model)
    return started
  }).catch(($, e, next) => next(e))

  // A backstop for the spawn hook: the run's opening prompt names its delegation.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined && !s.live.has(e.agentId)) {
      const decision = s.byPrompt.get(e.text)
      if (decision !== undefined && decision.status === 'running') bind(s, decision, e.agentId)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Tool errors inside a routed subagent count toward raising its effort.
  on('tool.call', async ($, e, next) => {
    const watched = e.agentId === undefined ? undefined : s.live.get(e.agentId)
    if (watched === undefined) return next(e)

    const ran = await next(e)
    if (ran.deny === undefined) {
      if (ran.isError === true) {
        watched.errors += 1
        watched.streak += 1
      } else {
        watched.streak = 0
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Each request a routed subagent makes: note the effort it really goes out
  // at, raise it if the run is struggling (on the 5.5 models with an API key or
  // subscription that keeps the subagent's prompt cache), and price it.
  on('turn.step', async function* ($, e, next) {
    const run = e.agentId === undefined ? undefined : s.live.get(e.agentId)
    if (run === undefined) return yield* next(e)

    let outgoing = e
    if (isEffort(e.effort)) {
      if (run.effort === undefined) {
        observeEffort(s, run, e.effort)
        showStatus($, s)
      }
      if (s.enabled && run.adjustable && run.effort !== undefined && run.startEffort !== undefined) {
        run.steps += 1
        const reason = bumpReason({ ...run, startEffort: run.startEffort, effort: run.effort })
        const raised = raise(run.effort)
        if (reason !== undefined && raised !== run.effort && effortRank(raised) <= effortRank(run.ceiling)) {
          run.effort = raised
          run.bumps += 1
          if (reason === 'a long run') {
            run.stepBumped = true
          } else {
            run.errors = 0
            run.streak = 0
          }
          run.decision.raised += 1
          run.decision.finalEffort = raised
          s.raises += 1
          $.ui.toast(`"${short(run.decision.task.description, 32)}" raised to ${raised} effort (${reason})`)
          showStatus($, s)
        }
        if (run.effort !== e.effort) outgoing = { ...e, effort: run.effort }
      }
    }

    const result = yield* next(outgoing)
    if (result.usage !== null) {
      const tokens = toTokens(result.usage)
      accountedAdd(run, tokens)
      record(s, run.decision, result.usage.model, tokens)
    }
    return result
  })

  // A routed subagent's run ended: price what the per-request count missed,
  // then read its ROUTER line and learn from it.
  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    const agentId = e.agentId
    const run = agentId === undefined ? undefined : s.live.get(agentId)
    if (agentId === undefined || run === undefined) return ended

    s.live.delete(agentId)
    record(s, run.decision, e.usage?.model, subtractTokens(toTokens(e.usage), run.accounted))
    await settle($, s, run.decision, e.reason, e.answer)
    showStatus($, s)
    return ended
  }).catch(($, e, next) => next(e))

  // /tier-router: the full report goes to the transcript, which Claude never
  // reads, so checking it costs no tokens; Claude gets one summary line.
  on('command.run', { command: 'tier-router' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)

    if (verb === '' || verb === 'status') {
      for (const line of reportLines(s)) $.ui.log(line)
      return { text: summaryLine(s) }
    }
    if (verb === 'share') {
      return { text: reportLines(s).join('\n') }
    }
    if (verb === 'export') {
      // From the store, so results other sessions recorded are included too.
      const cal = readCalibration(await $.store.get(STORE_KEY))
      if (!hasResults(cal)) {
        return {
          text: s.config.learn
            ? 'Nothing to export yet: no routed subagent has finished and reported back.'
            : 'Nothing to export: learning is off, so no results are kept.',
        }
      }
      const text = exportText(cal, { tierRouter: TIER_ROUTER_VERSION, claudeCode: s.claudeCode, profile: s.profile })
      $.ui.log(text)
      let copied = false
      try {
        copied = (await $.ui.copy({ text })).isCopied
      } catch {
        // No clipboard here (a remote surface, say): the transcript still has it.
      }
      return {
        text: `Your routing results (outcome counts only, no task text) are in the transcript${copied ? ' and on your clipboard' : ''}. To help tune the defaults, read them over, then paste them into a "Share routing data" issue: ${SHARE_URL}`,
      }
    }
    if (verb === 'on' || verb === 'off') {
      s.enabled = verb === 'on'
      showStatus($, s)
      return {
        text: s.enabled
          ? 'Routing is on: subagent tasks are routed by difficulty.'
          : 'Routing is off for this session: subagents run on their usual model and effort.',
      }
    }
    if (verb === 'mode' || verb === 'profile') {
      const chosen = PROFILES.find(p => p === arg)
      if (chosen === undefined) return { text: `Usage: /tier-router mode frugal|balanced|quality (now ${s.profile}).` }
      s.profile = chosen
      return { text: `The routing profile is ${s.profile} for this session.` }
    }
    if (verb === 'reset') {
      s.calibration = emptyCalibration()
      await $.store.delete(STORE_KEY)
      return { text: 'Cleared what the router learned; routing starts from its defaults again.' }
    }
    return { text: `Usage: /tier-router ${USAGE}` }
  })
}
