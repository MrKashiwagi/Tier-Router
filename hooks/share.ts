/**
 * `/tier-router export`: what the router has learned, as one line of JSON the
 * person can choose to share (a "Share routing data" issue on GitHub), so the
 * defaults can be tuned from many people's results. It holds outcome counts
 * and learned adjustments only: no task text, file names, times or costs.
 * Nothing is sent anywhere by the mod itself.
 */
import { parseRunKey } from './router.ts'
import type { Calibration, Counts } from './router.ts'

/** Keep in step with `version` in .claude-plugin/plugin.json. */
export const TIER_ROUTER_VERSION = '0.3.0'
export const REPO_URL = 'https://github.com/MrKashiwagi/tier-router'
export const SHARE_URL = `${REPO_URL}/issues/new?template=share-routing-data.yml`

export const EXPORT_COLUMNS = ['kind', 'via', 'level', 'model', 'effort', 'ok', 'miss', 'over', 'strain'] as const
/** A transcript notice shows its first 2,000 characters on the terminal. */
export const EXPORT_MAX_CHARS = 1900

export type ExportMeta = { tierRouter: string; claudeCode?: string; profile: string }
export type ExportRow = [string, string, string, string, string, number, number, number, number]

const total = (c: Counts): number => c.ok + c.miss + c.over + c.strain
const rowTotal = (r: ExportRow): number => r[5] + r[6] + r[7] + r[8]
const rowName = (r: ExportRow): string => r.slice(0, 5).join('|')

/** Whether there is anything to export. */
export function hasResults(cal: Calibration): boolean {
  return Object.values(cal.counts).some(c => total(c) > 0) || Object.values(cal.runs).some(c => total(c) > 0)
}

/** The outcome table, the most-run rows first. */
export function exportRows(cal: Calibration): ExportRow[] {
  const rows: ExportRow[] = []
  for (const [key, c] of Object.entries(cal.runs)) {
    const k = parseRunKey(key)
    if (k === undefined || total(c) === 0) continue
    rows.push([k.kind, k.via, k.level, k.model, k.effort, c.ok, c.miss, c.over, c.strain])
  }
  return rows.sort((a, b) => rowTotal(b) - rowTotal(a) || rowName(a).localeCompare(rowName(b)))
}

/**
 * The export as one line of JSON, at most `maxChars` long: where the table
 * does not fit, its least-run rows are left out and `omitted` says how many.
 */
export function exportText(cal: Calibration, meta: ExportMeta, maxChars = EXPORT_MAX_CHARS): string {
  const kinds: Record<string, [number, number, number, number]> = {}
  for (const [kind, c] of Object.entries(cal.counts)) {
    if (total(c) > 0) kinds[kind] = [c.ok, c.miss, c.over, c.strain]
  }
  const learned = Object.fromEntries(Object.entries(cal.bias).filter(([, b]) => b !== 0))
  const head = {
    tierRouter: meta.tierRouter,
    ...(meta.claudeCode === undefined ? {} : { claudeCode: meta.claudeCode }),
    profile: meta.profile,
    learned,
    kinds,
    columns: EXPORT_COLUMNS,
  }

  const rows = exportRows(cal)
  let kept = rows.length
  let text = JSON.stringify({ ...head, rows })
  while (text.length > maxChars && kept > 0) {
    kept -= 1
    text = JSON.stringify({ ...head, rows: rows.slice(0, kept), omitted: rows.length - kept })
  }
  return text
}
