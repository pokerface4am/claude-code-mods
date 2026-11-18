// Pure budget logic: parsing, ceilings, levels, text. No `$` here, so it is unit-testable.
// The words themselves live in ./messages; a function that produces text takes the table as `t`.

import type { Messages } from './messages'

export const WINDOWS = ['five_hour', 'seven_day'] as const
export type WindowKind = (typeof WINDOWS)[number]

export const LABEL: Record<WindowKind, string> = { five_hour: '5h', seven_day: 'week' }

/** Points before the ceiling at which new subagents are refused. */
export const WARN_MARGIN = 2

/** A resetsAt that moves by more than this means the window really reset (not jitter). */
const RESET_SHIFT_MS = 30 * 60 * 1000

export type Reading = { kind: string; percentUsed: number; resetsAt?: string }

/** Relative allowance: `amount` points on top of `baseline`; baseline fills on first reading. */
export type RelSpec = { amount: number; baseline?: number; resetsAt?: string }
export type WinSpec = { abs?: number; rel?: RelSpec }
export type Budget = Partial<Record<WindowKind, WinSpec>>

export type Level = 'ok' | 'warn' | 'over'
export type WindowState = {
  kind: WindowKind
  used?: number
  /** Estimated points the requests in flight will add (0 when unknown). */
  pending: number
  ceiling?: number
  level: Level
}

/** Estimated points per window the in-flight requests will add. */
export type Pending = Partial<Record<WindowKind, number>>

export type Command =
  | { kind: 'show' }
  | { kind: 'help' }
  | { kind: 'off'; windows: readonly WindowKind[] }
  | { kind: 'set'; budget: Budget }
  | { kind: 'poll'; seconds: number }
  | { kind: 'error'; message: string }

const WINDOW_ALIASES: Record<string, WindowKind> = {
  '5h': 'five_hour',
  week: 'seven_day',
  wk: 'seven_day',
  '7d': 'seven_day',
}

const TOKEN = /^(5h|week|wk|7d)(<=|\+)(\d+(?:\.\d+)?)%?$/i

export function isEmpty(budget: Budget): boolean {
  return WINDOWS.every(w => budget[w] === undefined)
}

/** Parses `/budget` args against the current budget; never mutates it. */
export function parseCommand(t: Messages, args: string, current: Budget): Command {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || tokens[0] === 'show') return { kind: 'show' }
  if (tokens[0] === 'help') return { kind: 'help' }
  if (tokens[0] === 'poll') {
    const arg = tokens[1]?.toLowerCase()
    if (arg === 'off') return { kind: 'poll', seconds: 0 }
    const seconds = Number(arg)
    if (!(seconds >= MIN_POLL_SECONDS && seconds <= 3600)) {
      return { kind: 'error', message: t.pollArg(MIN_POLL_SECONDS) }
    }
    return { kind: 'poll', seconds }
  }
  if (tokens[0] === 'off') {
    const rest = tokens.slice(1).map(t => WINDOW_ALIASES[t.toLowerCase()])
    if (rest.some(w => w === undefined)) return { kind: 'error', message: t.unknownWindow(tokens.slice(1).join(' ')) }
    return { kind: 'off', windows: rest.length ? (rest as WindowKind[]) : WINDOWS }
  }

  let next: Budget = { ...current }
  for (const token of tokens) {
    const m = TOKEN.exec(token)
    if (!m) return { kind: 'error', message: t.badToken(token) }
    const kind = WINDOW_ALIASES[m[1]!.toLowerCase()]!
    const value = Number(m[3])
    if (!(value > 0 && value <= 100)) return { kind: 'error', message: t.badValue(token) }
    const spec: WinSpec = next[kind] ?? {}
    next = {
      ...next,
      [kind]: m[2] === '<=' ? { ...spec, abs: value } : { ...spec, rel: { amount: value } },
    }
  }
  return { kind: 'set', budget: next }
}

export function withoutWindows(budget: Budget, windows: readonly WindowKind[]): Budget {
  return Object.fromEntries(
    WINDOWS.filter(w => !windows.includes(w) && budget[w] !== undefined).map(w => [w, budget[w]]),
  ) as Budget
}

function readingOf(readings: readonly Reading[], kind: WindowKind): Reading | undefined {
  return readings.find(r => r.kind === kind)
}

function hasReset(oldAt: string | undefined, newAt: string | undefined): boolean {
  if (!oldAt || !newAt) return false
  const shift = Date.parse(newAt) - Date.parse(oldAt)
  return Number.isFinite(shift) && shift > RESET_SHIFT_MS
}

/**
 * Fills relative baselines from the first reading, and restarts a relative
 * allowance when its window reset (a fresh window gets a fresh allowance).
 * Returns the same object when nothing changed.
 */
export function normalize(budget: Budget, readings: readonly Reading[]): Budget {
  let changed = false
  const next: Budget = { ...budget }
  for (const kind of WINDOWS) {
    const rel = budget[kind]?.rel
    const reading = readingOf(readings, kind)
    if (!rel || !reading) continue
    if (rel.baseline === undefined || hasReset(rel.resetsAt, reading.resetsAt)) {
      next[kind] = { ...budget[kind], rel: { amount: rel.amount, baseline: reading.percentUsed, resetsAt: reading.resetsAt } }
      changed = true
    } else if (!rel.resetsAt && reading.resetsAt) {
      next[kind] = { ...budget[kind], rel: { ...rel, resetsAt: reading.resetsAt } }
      changed = true
    }
  }
  return changed ? next : budget
}

export function ceilingOf(spec: WinSpec | undefined): number | undefined {
  if (!spec) return undefined
  const candidates = [
    spec.abs,
    spec.rel && spec.rel.baseline !== undefined ? spec.rel.baseline + spec.rel.amount : undefined,
  ].filter((v): v is number => v !== undefined)
  return candidates.length ? Math.min(...candidates) : undefined
}

/**
 * Levels each budgeted window: `over` when the reading plus what the requests
 * in flight are expected to add reaches the ceiling, so the stop lands before
 * the ceiling rather than a few points past it.
 */
export function evaluate(budget: Budget, readings: readonly Reading[], pending: Pending = {}): WindowState[] {
  return WINDOWS.filter(w => budget[w] !== undefined).map(kind => {
    const used = readingOf(readings, kind)?.percentUsed
    const add = Math.max(0, pending[kind] ?? 0)
    const ceiling = ceilingOf(budget[kind])
    const level: Level =
      used === undefined || ceiling === undefined
        ? 'ok'
        : used + add >= ceiling
          ? 'over'
          : used + add >= ceiling - WARN_MARGIN
            ? 'warn'
            : 'ok'
    return { kind, used, pending: add, ceiling, level }
  })
}

export function worst(states: readonly WindowState[]): Level {
  if (states.some(s => s.level === 'over')) return 'over'
  if (states.some(s => s.level === 'warn')) return 'warn'
  return 'ok'
}

const fmt = (n: number | undefined) => (n === undefined ? '?' : String(Math.round(n * 10) / 10))

export function statusText(states: readonly WindowState[]): string | undefined {
  if (states.length === 0) return undefined
  const mark: Record<Level, string> = { ok: '', warn: '⚠', over: '⛔' }
  return 'budget ' + states.map(s => `${mark[s.level]}${LABEL[s.kind]} ${fmt(s.used)}${s.pending > 0 ? `+${fmt(s.pending)}` : ''}/${fmt(s.ceiling)}`).join(' · ')
}

export function blockMessage(t: Messages, states: readonly WindowState[]): string {
  const hit = states
    .filter(s => s.level === 'over')
    .map(s => t.hit(LABEL[s.kind], fmt(s.used), s.pending > 0 ? fmt(s.pending) : undefined, fmt(s.ceiling)))
  return t.blocked(hit.join(t.listSep))
}

export function warnMessage(t: Messages, states: readonly WindowState[]): string {
  const near = states.filter(s => s.level !== 'ok').map(s => `${LABEL[s.kind]} ${fmt(s.used)}/${fmt(s.ceiling)}`)
  return t.nearCeiling(near.join(t.listSep))
}

function describeSpec(t: Messages, spec: WinSpec): string {
  const parts: string[] = []
  if (spec.abs !== undefined) parts.push(t.abs(spec.abs))
  if (spec.rel) parts.push(t.rel(spec.rel.amount, spec.rel.baseline === undefined ? undefined : fmt(spec.rel.baseline)))
  return parts.join(' / ')
}

export type ShowInfo = { pending?: Pending; pollSeconds?: number; costPerRequest?: number; inFlight?: number }

/** `5h 48/70 [absolute ≤70] ok · week ...`: the windows on one line. */
function windowsLine(t: Messages, budget: Budget, states: readonly WindowState[]): string {
  return states
    .map(s => `${LABEL[s.kind]} ${fmt(s.used)}${s.pending > 0 ? `+${fmt(s.pending)}` : ''}/${fmt(s.ceiling)} [${describeSpec(t, budget[s.kind]!)}] ${t.level[s.level]}`)
    .join(' · ')
}

/** What `/budget` with no arguments prints: two lines, the usage behind `/budget help`. */
export function showText(t: Messages, budget: Budget, readings: readonly Reading[], info: ShowInfo = {}): string {
  const poll = info.pollSeconds ? t.polling(info.pollSeconds) : t.notPolling
  if (isEmpty(budget)) return t.noBudget(poll)
  const states = evaluate(budget, readings, info.pending)
  const cost = info.costPerRequest !== undefined ? t.cost(fmt(info.costPerRequest), info.inFlight ?? 0) : ''
  return [windowsLine(t, budget, states), `${poll}${cost}${t.helpHint}`].join('\n')
}

/** The one-line toast a change confirms with, so the transcript keeps nothing. */
export function confirmText(t: Messages, cmd: Command, budget: Budget, readings: readonly Reading[], info: ShowInfo = {}): string {
  if (cmd.kind === 'poll') return cmd.seconds > 0 ? t.pollSet(cmd.seconds) : t.pollOff
  if (isEmpty(budget)) return t.budgetOff
  return t.budgetSet(windowsLine(t, budget, evaluate(budget, readings, info.pending)))
}

/** How many of a transcript's last lines a fork is matched on. */
export const TAIL_LINES = 400

/**
 * The commands that print a file's last TAIL_LINES lines, the platform's own first: PowerShell
 * on Windows, `tail` elsewhere, each followed by the other as a fallback. Each is an argv, run
 * with no shell, so only PowerShell's own quoting of the path matters.
 */
export function tailCommands(path: string, isWindows: boolean): string[][] {
  const powershell = [
    'powershell',
    '-NoProfile',
    '-Command',
    `Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -Tail ${TAIL_LINES} -Encoding UTF8`,
  ]
  const tail = ['tail', '-n', String(TAIL_LINES), path]
  return isWindows ? [powershell, tail] : [tail, powershell]
}

/** Uuids of the transcript rows in a JSONL text, in file order. */
export function uuidsOf(jsonl: string): string[] {
  const out: string[] = []
  for (const m of jsonl.matchAll(/^\{.*?"uuid":"([0-9a-f-]{36})"/gm)) out.push(m[1]!)
  return out
}

export type SessionRecord = {
  sessionId: string
  budget: Budget
  /** Most recent main-loop transcript row uuids, newest last (for /fork lookup). */
  ring: string[]
  updatedAt: number
}

/**
 * Picks the parent of a forked transcript: the record holding the latest of
 * the fork's copied uuids. Returns undefined when none matches.
 */
export function findParent(forkUuids: readonly string[], records: readonly SessionRecord[], selfId: string): SessionRecord | undefined {
  for (let i = forkUuids.length - 1; i >= 0; i--) {
    const uuid = forkUuids[i]!
    const matches = records.filter(r => r.sessionId !== selfId && r.ring.includes(uuid))
    if (matches.length) return [...matches].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }
  return undefined
}

export const RING_SIZE = 64

export function pushRing(ring: readonly string[], uuid: string): string[] {
  return [...ring.filter(u => u !== uuid), uuid].slice(-RING_SIZE)
}

export const MIN_POLL_SECONDS = 15
export const DEFAULT_POLL_SECONDS = 90

/** Settings shared by every session of this account, kept under one store key. */
export type Config = { pollSeconds: number }

/**
 * Readings out of the account usage endpoint's body (what /usage shows):
 * `five_hour` / `seven_day` as `{ utilization, resets_at }`. Empty when the
 * body has neither, so a changed shape falls back to the response headers.
 */
export function parseUsageBody(text: string): Reading[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  if (!json || typeof json !== 'object') return []
  const out: Reading[] = []
  for (const kind of WINDOWS) {
    const w = (json as Record<string, unknown>)[kind]
    if (!w || typeof w !== 'object') continue
    const { utilization, resets_at } = w as { utilization?: unknown; resets_at?: unknown }
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) continue
    out.push({ kind, percentUsed: utilization, resetsAt: typeof resets_at === 'string' ? resets_at : undefined })
  }
  return out
}

/**
 * One reading per window out of two sources: within the same window the
 * higher figure wins (usage only grows, and the two sources round
 * differently); once one of them shows a reset, that newer window wins.
 * Kinds only `headers` carries (a gateway's spend_limit) pass through.
 */
export function mergeReadings(headers: readonly Reading[], polled: readonly Reading[]): Reading[] {
  const out: Reading[] = []
  const seen = new Set<string>()
  for (const h of headers) {
    seen.add(h.kind)
    const p = polled.find(r => r.kind === h.kind)
    if (!p) out.push(h)
    else if (hasReset(h.resetsAt, p.resetsAt)) out.push(p)
    else if (hasReset(p.resetsAt, h.resetsAt)) out.push(h)
    else out.push(p.percentUsed > h.percentUsed ? p : h)
  }
  for (const p of polled) if (!seen.has(p.kind)) out.push(p)
  return out
}

/** How many completed requests the per-request cost is averaged over. */
export const COST_SPAN = 8

/** A header reading taken when `completed` requests had finished. */
export type CostSample = { completed: number; used: number; resetsAt?: string }

/**
 * Adds a sample, keeping those within COST_SPAN completions of it; a window
 * reset or a reading that went down starts the series over.
 */
export function pushSample(samples: readonly CostSample[], s: CostSample): CostSample[] {
  const last = samples[samples.length - 1]
  if (last && (hasReset(last.resetsAt, s.resetsAt) || s.used < last.used)) return [s]
  if (last && last.completed === s.completed) {
    // Same completion count: keep the later reading for that point.
    return [...samples.slice(0, -1), { ...s, used: Math.max(s.used, last.used) }]
  }
  return [...samples, s].filter(x => x.completed >= s.completed - COST_SPAN)
}

/**
 * Points one request is expected to add: the rise across the kept samples
 * divided by the requests completed meanwhile. Other sessions' use inflates
 * it, which errs toward stopping earlier, never later. 0 until two samples
 * with completions between them exist.
 */
export function costPerRequest(samples: readonly CostSample[]): number {
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last || last.completed <= first.completed) return 0
  return Math.max(0, (last.used - first.used) / (last.completed - first.completed))
}

/** The estimated addition per window for `inFlight` requests. */
export function pendingFor(costs: Partial<Record<WindowKind, number>>, inFlight: number): Pending {
  const out: Pending = {}
  for (const kind of WINDOWS) {
    const c = costs[kind]
    if (c !== undefined && inFlight > 0) out[kind] = c * inFlight
  }
  return out
}
