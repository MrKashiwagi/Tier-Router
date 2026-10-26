/**
 * What routed work costs, estimated at Anthropic's API list prices, per
 * request. On a Claude subscription nothing is billed per token, so these
 * figures show relative usage rather than charges; Claude Code's /usage is
 * the authoritative count either way.
 */

export const PRICES_AS_OF = 'October 2026'

/** USD per million tokens. Cache writes are the 5-minute kind subagents use. */
export type Rates = { input: number; output: number; cacheWrite: number; cacheRead: number }
type PriceEntry = { name: string; base: Rates; over100k?: Rates }

export const PRICES: Readonly<Record<string, PriceEntry>> = {
  'opus-5-5': { name: 'Opus 5.5', base: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
  'sonnet-5-5': { name: 'Sonnet 5.5', base: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 } },
  'haiku-5-5': {
    name: 'Haiku 5.5',
    base: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    // A request whose prompt (input + cache reads + cache writes) passes
    // 100,000 tokens is priced at these rates, request by request.
    over100k: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
  },
  'fable-5-1': { name: 'Fable 5.1', base: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 } },
}

export const TIER_TOKENS = 100_000

/** What a bare alias resolves to on the Anthropic API. */
const ALIAS_VERSION: Readonly<Record<string, string>> = { opus: '5-5', sonnet: '5-5', haiku: '5-5', fable: '5-1' }

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type UsageLike = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export const noTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export const toTokens = (u: UsageLike | null | undefined): Tokens => ({
  input: n(u?.input_tokens),
  output: n(u?.output_tokens),
  cacheRead: n(u?.cache_read_input_tokens),
  cacheWrite: n(u?.cache_creation_input_tokens),
})

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** What `total` holds beyond `seen`, never below zero. */
export const subtractTokens = (total: Tokens, seen: Tokens): Tokens => ({
  input: Math.max(0, total.input - seen.input),
  output: Math.max(0, total.output - seen.output),
  cacheRead: Math.max(0, total.cacheRead - seen.cacheRead),
  cacheWrite: Math.max(0, total.cacheWrite - seen.cacheWrite),
})

export const tokenTotal = (t: Tokens): number => t.input + t.output + t.cacheRead + t.cacheWrite

/**
 * The price table entry for a model id, alias or display name
 * ('claude-haiku-5-5-20260601', 'opus', 'Sonnet 5.5'); undefined for a model
 * not in the table, such as an older Haiku on another provider.
 */
export function priceKey(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const m = /(opus|sonnet|haiku|fable)(?:[\s_-]*(\d{1,2})(?:[.\s_-](\d{1,2})(?!\d))?)?/i.exec(model)
  if (m === null) return undefined
  const family = (m[1] ?? '').toLowerCase()
  const version =
    m[2] === undefined ? ALIAS_VERSION[family] : m[3] === undefined ? m[2] : `${m[2]}-${m[3]}`
  const key = `${family}-${version ?? ''}`
  return key in PRICES ? key : undefined
}

export const priceName = (key: string): string => PRICES[key]?.name ?? key

/** One request's cost in USD, with Haiku's prompt-length tier; undefined for an unknown model. */
export function requestCost(model: string | undefined, t: Tokens): number | undefined {
  const key = priceKey(model)
  const entry = key === undefined ? undefined : PRICES[key]
  if (entry === undefined) return undefined
  const prompt = t.input + t.cacheRead + t.cacheWrite
  const r = entry.over100k !== undefined && prompt > TIER_TOKENS ? entry.over100k : entry.base
  return (t.input * r.input + t.output * r.output + t.cacheWrite * r.cacheWrite + t.cacheRead * r.cacheRead) / 1_000_000
}

/** A running total of priced requests, with what the same tokens would cost on a baseline model. */
export type Ledger = {
  tokens: Tokens
  requests: number
  /** Haiku requests priced at its over-100K-token rates. */
  overTier: number
  cost: number
  /** False once any request's model was not in the price table. */
  costKnown: boolean
  baseline: number
  baselineKnown: boolean
}

export const emptyLedger = (): Ledger => ({
  tokens: noTokens(),
  requests: 0,
  overTier: 0,
  cost: 0,
  costKnown: true,
  baseline: 0,
  baselineKnown: true,
})

/** Adds one request (or a summed remainder) to a ledger. */
export function addRequest(ledger: Ledger, model: string | undefined, t: Tokens, baselineModel?: string): void {
  if (tokenTotal(t) === 0) return
  ledger.tokens = addTokens(ledger.tokens, t)
  ledger.requests += 1
  const key = priceKey(model)
  if (key !== undefined && PRICES[key]?.over100k !== undefined && t.input + t.cacheRead + t.cacheWrite > TIER_TOKENS) {
    ledger.overTier += 1
  }

  const cost = requestCost(model, t)
  if (cost === undefined) ledger.costKnown = false
  else ledger.cost += cost

  const baseline = requestCost(baselineModel, t)
  if (baseline === undefined) ledger.baselineKnown = false
  else ledger.baseline += baseline
}

export function money(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 10) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(0)}`
}

export function tokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k`
  return String(Math.round(count))
}
