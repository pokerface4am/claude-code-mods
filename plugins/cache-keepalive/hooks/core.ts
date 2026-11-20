// Pure keep-alive logic: options, arguments, the decision, text. No `$` here, so it is
// unit-testable. The words themselves live in ./messages; a function that produces text takes
// the table as `t`.

import type { ModelUsage, PluginOptions } from 'claude-code'

import type { KeepalivePlan } from '../types'
import type { Messages } from './messages'

export const PLUGIN = 'cache-keepalive'
export const COMMAND = 'keepalive'
export const MINUTE_MS = 60_000

/** The one user message a ping appends: the model answers with one character. */
export const PING_PROMPT =
  '[automated cache keep-alive ping] Reply with a single period and nothing else.'

export type Options = {
  intervalMinutes: number
  cacheTtlMinutes: number
  defaultMax: number
  retryMinutes: number
  /** Read Claude Code's idle compaction as off while this mod is loaded. */
  disableIdleCompaction: boolean
}

export const DEFAULTS: Options = {
  intervalMinutes: 50,
  cacheTtlMinutes: 60,
  defaultMax: 3,
  retryMinutes: 5,
  disableIdleCompaction: true,
}

function positive(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function flag(raw: unknown, fallback: boolean): boolean {
  if (raw === true || raw === 'true') return true
  if (raw === false || raw === 'false') return false
  return fallback
}

/** The manifest's options: positive numbers and a flag, defaults filled in for anything else. */
export function readOptions(raw: PluginOptions | undefined): Options {
  const r = raw ?? {}
  return {
    intervalMinutes: positive(r.intervalMinutes, DEFAULTS.intervalMinutes),
    cacheTtlMinutes: positive(r.cacheTtlMinutes, DEFAULTS.cacheTtlMinutes),
    defaultMax: Math.max(1, Math.round(positive(r.defaultMax, DEFAULTS.defaultMax))),
    retryMinutes: positive(r.retryMinutes, DEFAULTS.retryMinutes),
    disableIdleCompaction: flag(r.disableIdleCompaction, DEFAULTS.disableIdleCompaction),
  }
}

/** The settings.json key that switches Claude Code's idle compaction. */
export const IDLE_COMPACTION_KEY = 'idleCompaction'

/**
 * Whether the merged settings should read idle compaction as off: the option is on and nothing
 * says anything about it, neither the settings as merged nor any one source. A value a person
 * or an administrator wrote in a settings file, on or off, stands.
 * Idle compaction and keep-alive answer the same problem in opposite ways (summarize the
 * conversation, or keep it as it is), so with this mod loaded the default flips to keeping it.
 */
export function shouldTurnIdleCompactionOff(isEnabled: boolean, merged: object, layers: readonly { settings: object }[]): boolean {
  if (!isEnabled) return false
  const mentions = (settings: object) => (settings as Record<string, unknown>)[IDLE_COMPACTION_KEY] !== undefined
  return !mentions(merged) && !layers.some(l => mentions(l.settings))
}

/**
 * Whether idle compaction is on with this mod loaded, from `written`: the key's value as a
 * settings read gives it, undefined when nothing sets it. It holds whether or not the read
 * already went through this mod's own hook: false stays off, a written true stays on, and
 * nothing written falls to the option.
 */
export function isIdleCompactionOn(isEnabled: boolean, written: unknown): boolean {
  return written === undefined ? !isEnabled : written !== false
}

export type Command =
  | { kind: 'status' }
  | { kind: 'off' }
  | { kind: 'set'; max: number }
  | { kind: 'add'; count: number }
  | { kind: 'help'; error: string }

/** `/keepalive` (status), `off`, `on`, `N` (set the max), `+N` (raise the max). */
export function parseArgs(t: Messages, args: string, defaultMax: number): Command {
  const a = args.trim()
  if (a === '') return { kind: 'status' }
  if (/^(off|stop|0)$/i.test(a)) return { kind: 'off' }
  if (/^on$/i.test(a)) return { kind: 'set', max: defaultMax }
  const add = /^\+(\d+)$/.exec(a)
  if (add) {
    const count = Number(add[1])
    return count >= 1 ? { kind: 'add', count } : { kind: 'help', error: t.plusZero }
  }
  if (/^\d+$/.test(a)) return { kind: 'set', max: Number(a) }
  return { kind: 'help', error: t.badArg(a) }
}

/** The next plan after a command; null means off. */
export function applyCommand(
  plan: KeepalivePlan | null,
  cmd: Command,
): KeepalivePlan | null {
  switch (cmd.kind) {
    case 'off':
      return null
    case 'set':
      return { max: cmd.max, used: plan?.used ?? 0 }
    case 'add':
      return plan ? { ...plan, max: plan.max + cmd.count } : { max: cmd.count, used: 0 }
    default:
      return plan
  }
}

export type Decision =
  | { kind: 'off' }
  | { kind: 'running' }
  | { kind: 'exhausted' }
  | { kind: 'no-anchor' }
  | { kind: 'expired'; elapsedMs: number }
  | { kind: 'fire'; delayMs: number }

export type Situation = {
  plan: KeepalivePlan | null
  lastApiAt: number | null
  now: number
  /** When the last failed ping ran; the next one waits `retryMinutes` from it. */
  retryFrom: number | null
  isTurnRunning: boolean
}

/** What to do now: wait for a running turn, fire after a delay, or nothing and why. */
export function decide(s: Situation, o: Options): Decision {
  if (s.plan === null) return { kind: 'off' }
  if (s.isTurnRunning) return { kind: 'running' }
  if (s.plan.used >= s.plan.max) return { kind: 'exhausted' }
  if (s.lastApiAt === null) return { kind: 'no-anchor' }
  const ttlMs = o.cacheTtlMinutes * MINUTE_MS
  const elapsedMs = s.now - s.lastApiAt
  if (elapsedMs >= ttlMs) return { kind: 'expired', elapsedMs }
  const due =
    s.retryFrom === null
      ? s.lastApiAt + o.intervalMinutes * MINUTE_MS
      : s.retryFrom + o.retryMinutes * MINUTE_MS
  if (due - s.lastApiAt >= ttlMs) return { kind: 'expired', elapsedMs }
  return { kind: 'fire', delayMs: Math.max(0, due - s.now) }
}

export function minutes(ms: number): string {
  const m = Math.round(ms / MINUTE_MS)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/** The status line entry; undefined clears it. */
const STATUS_HEAD = 'keepalive '

export function statusText(t: Messages, plan: KeepalivePlan | null, d: Decision): string | undefined {
  if (plan === null || d.kind === 'off') return undefined
  const head = `${STATUS_HEAD}${plan.used}/${plan.max}`
  switch (d.kind) {
    case 'running':
      return `${head} · ${t.statusRunning}`
    case 'exhausted':
      return `${head} · ${t.statusExhausted}`
    case 'no-anchor':
      return `${head} · ${t.statusNoAnchor}`
    case 'expired':
      return `${head} · ${t.statusExpired}`
    case 'fire':
      return d.delayMs === 0 ? `${head} · ${t.statusPinging}` : `${head} · ${t.statusNext(minutes(d.delayMs))}`
  }
}

/** The one-line answer of a command that changed the arming. */
export function shortText(t: Messages, plan: KeepalivePlan | null, d: Decision): string {
  const line = statusText(t, plan, d)
  return line === undefined ? t.shortOff : t.shortOn(line.slice(STATUS_HEAD.length))
}

/**
 * The full answer of `/keepalive` with no arguments. Its last line says whether idle compaction
 * is on, as the settings read now: the other thing that can happen to an idle conversation.
 */
export function describe(t: Messages, plan: KeepalivePlan | null, d: Decision, o: Options, isIdleCompactionOn: boolean): string {
  const idle = isIdleCompactionOn ? t.idleOn : t.idleOff
  if (plan === null) return [t.describeOff(o.defaultMax, o.intervalMinutes), idle].join('\n')
  const lines = [t.describeOn(plan.used, plan.max)]
  switch (d.kind) {
    case 'running':
      lines.push(t.describeRunning)
      break
    case 'exhausted':
      lines.push(t.describeExhausted)
      break
    case 'no-anchor':
      lines.push(t.describeNoAnchor)
      break
    case 'expired':
      lines.push(t.describeExpired(minutes(d.elapsedMs)))
      break
    case 'fire':
      lines.push(d.delayMs === 0 ? t.describePinging : t.describeNext(minutes(d.delayMs)))
      break
  }
  lines.push(t.describeTiming(o.intervalMinutes, o.cacheTtlMinutes))
  lines.push(idle)
  return lines.join('\n')
}

/** Below this share of the prompt served from cache, the ping found the cache cold. */
export const COLD_RATIO = 0.5

export type Hit = { ratio: number; cached: number; total: number }

/** How much of the ping's prompt the cache served. */
export function hitOf(u: ModelUsage): Hit {
  const cached = u.cache_read_input_tokens
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return { ratio: total === 0 ? 0 : cached / total, cached, total }
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

/** One transcript line per ping, for the person to read when they are back. */
export function pingReport(t: Messages, plan: KeepalivePlan, hit: Hit): string {
  const pct = Math.round(hit.ratio * 100)
  const head = `${STATUS_HEAD}${plan.used}/${plan.max}`
  if (hit.ratio >= COLD_RATIO) return t.pingWarm(head, k(hit.cached), k(hit.total), pct)
  return t.pingCold(head, pct, k(hit.total))
}
