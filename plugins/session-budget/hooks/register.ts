import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  blockMessage,
  confirmText,
  costPerRequest,
  DEFAULT_POLL_SECONDS,
  evaluate,
  findParent,
  isEmpty,
  mergeReadings,
  normalize,
  parseCommand,
  parseUsageBody,
  pendingFor,
  pushRing,
  pushSample,
  showText,
  statusText,
  TAIL_LINES,
  tailCommands,
  uuidsOf,
  warnMessage,
  WINDOWS,
  withoutWindows,
  worst,
} from './core'
import type { Budget, Config, CostSample, Level, Pending, Reading, SessionRecord, WindowKind, WindowState } from './core'
import { fixedLang, langOfLocale, messages } from './messages'
import type { Lang, Messages } from './messages'

const KEY_PREFIX = 'budget:'
const CONFIG_KEY = 'budget-config'
const STALE_MS = 8 * 24 * 60 * 60 * 1000
const TAIL_TIMEOUT_MS = 15000
/** The account usage endpoint /usage reads: live figures, other sessions included. */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_HEADERS = { 'anthropic-beta': 'oauth-2025-04-20' }
const POLL_FAILURES_BEFORE_NOTICE = 3

/** This process's view of its session; rebuilt from $.store after a reload. */
type Live = {
  sid: string
  record: SessionRecord | undefined
  ring: string[]
  lastLevel: Level
  carryOnClear: boolean
  /** The last polled account figures; merged with the response headers' on every read. */
  polled: Reading[]
  /** Model requests sent and not yet answered, main's and subagents' alike. */
  inFlight: number
  /** Model requests answered so far, the x-axis of the cost samples. */
  completed: number
  /** Header readings against completions, per window: the per-request cost estimate. */
  samples: Record<WindowKind, CostSample[]>
}

let live: Live | undefined
let hasFaulted = false
let config: Config = { pollSeconds: DEFAULT_POLL_SECONDS }
let pollTimer: Timer | undefined
let pollFailures = 0
/** The words of this session's messages; set from the `language` option at session.start. */
let t: Messages = messages('en')

/** The `language` option when it names a language; under `auto`, the locale's (LC_ALL, LC_MESSAGES, LANG). */
async function pickLang($: EngineInterface, option: unknown): Promise<Lang> {
  return fixedLang(option) ?? langOfLocale([await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')])
}

const noSamples = (): Record<WindowKind, CostSample[]> => ({ five_hour: [], seven_day: [] })

async function current($: EngineInterface): Promise<Live> {
  const sid = await $.session.id()
  if (live && live.sid === sid) return live
  if (live && live.carryOnClear && live.record) {
    // /clear keeps the process going under a new id: the budget follows it.
    const moved: Live = { ...live, sid, carryOnClear: false, ring: [] }
    live = moved
    await save($, moved.record!.budget)
    return live
  }
  const stored = (await $.store.get(KEY_PREFIX + sid)) as SessionRecord | undefined
  const isSwitch = live !== undefined
  live = {
    sid,
    record: stored,
    ring: stored?.ring ?? [],
    lastLevel: 'ok',
    carryOnClear: false,
    polled: [],
    inFlight: 0,
    completed: 0,
    samples: noSamples(),
  }
  // On first load keep an inherited CC_SESSION_BUDGET for adoptFromEnv; on a session switch, replace it.
  if (stored || isSwitch) await exportEnv($, stored?.budget)
  return live
}

async function exportEnv($: EngineInterface, budget: Budget | undefined): Promise<void> {
  await $.env.set('CC_SESSION_BUDGET', budget && !isEmpty(budget) ? JSON.stringify(budget) : undefined)
}

/**
 * Persists `budget`. With `onlyIf`, a compare-and-set: nothing is written when
 * the live budget is no longer that object (an immediate /budget landed between
 * a check's read and its write), so the person's change is never overwritten.
 */
async function save($: EngineInterface, budget: Budget, onlyIf?: Budget): Promise<void> {
  const state = await current($)
  if (onlyIf && state.record?.budget !== onlyIf) return
  if (isEmpty(budget)) {
    live = { ...state, record: undefined }
    await $.store.delete(KEY_PREFIX + state.sid)
  } else {
    const record: SessionRecord = { sessionId: state.sid, budget, ring: state.ring, updatedAt: await $.clock.now() }
    live = { ...state, record }
    await $.store.set(KEY_PREFIX + state.sid, record)
  }
  await exportEnv($, budget)
  syncPoll($)
}

/** The response headers' figures, as the engine keeps them: one decimal, this session's last response. */
async function headerReadings($: EngineInterface): Promise<Reading[]> {
  return [...(await $.session.usage()).rateLimits]
}

/** Headers merged with the last poll: the fresher of the two per window. */
async function readingsNow($: EngineInterface): Promise<Reading[]> {
  const state = await current($)
  return mergeReadings(await headerReadings($), state.polled)
}

/** Points per request per window, from the header readings seen so far. */
function costs(state: Live): Partial<Record<WindowKind, number>> {
  const out: Partial<Record<WindowKind, number>> = {}
  for (const kind of WINDOWS) out[kind] = costPerRequest(state.samples[kind])
  return out
}

/** What the requests in flight (plus `extra` about to go) are expected to add. */
async function pendingNow($: EngineInterface, extra = 0): Promise<Pending> {
  const state = await current($)
  return pendingFor(costs(state), state.inFlight + extra)
}

/** Records the header readings at the current completion count, for the cost estimate. */
async function sampleCost($: EngineInterface, headers?: readonly Reading[]): Promise<void> {
  const readings = headers ?? (await headerReadings($))
  const state = await current($)
  const samples = { ...state.samples }
  for (const kind of WINDOWS) {
    const r = readings.find(x => x.kind === kind)
    if (r) samples[kind] = pushSample(state.samples[kind], { completed: state.completed, used: r.percentUsed, resetsAt: r.resetsAt })
  }
  live = { ...state, samples }
}

/**
 * Current window states; normalizes and persists the budget, refreshes the
 * status line. `extra` counts requests about to be sent on top of those in flight.
 */
async function check($: EngineInterface, given?: readonly Reading[], extra = 0): Promise<WindowState[]> {
  const readings = given ?? (await readingsNow($))
  const state = await current($)
  if (!state.record) return []
  const before = state.record.budget
  const budget = normalize(before, readings)
  if (budget !== before) await save($, budget, before)
  const states = evaluate(budget, readings, await pendingNow($, extra))
  await announce($, states)
  return states
}

async function announce($: EngineInterface, states: readonly WindowState[]): Promise<void> {
  const level = worst(states)
  const state = await current($)
  if (hasFaulted) hasFaulted = false
  $.ui.status(statusText(states))
  if (level !== state.lastLevel) {
    live = { ...state, lastLevel: level }
    if (level === 'warn') $.ui.toast(warnMessage(t, states))
    if (level === 'over') $.ui.toast(blockMessage(t, states))
  }
}

async function fault($: EngineInterface, err: unknown): Promise<void> {
  $.ui.status(t.faultStatus)
  if (!hasFaulted) $.ui.toast(t.faultToast(err instanceof Error ? err.message : String(err)))
  hasFaulted = true
}

// ---- account usage polling ----

async function loadConfig($: EngineInterface): Promise<void> {
  const stored = (await $.store.get(CONFIG_KEY)) as Partial<Config> | undefined
  if (stored && typeof stored.pollSeconds === 'number') config = { pollSeconds: stored.pollSeconds }
}

async function setPoll($: EngineInterface, pollSeconds: number): Promise<void> {
  config = { pollSeconds }
  await $.store.set(CONFIG_KEY, config)
  pollTimer?.cancel()
  pollTimer = undefined
  syncPoll($)
}

/** Runs the poll timer exactly when a budget is set and polling is on. */
function syncPoll($: EngineInterface): void {
  const wanted = live?.record !== undefined && config.pollSeconds > 0
  if (!wanted) {
    pollTimer?.cancel()
    pollTimer = undefined
    return
  }
  if (pollTimer) return
  pollTimer = $.clock.every(config.pollSeconds * 1000, () => {
    void poll($).catch(err => $.ui.toast(t.pollCrashed(err instanceof Error ? err.message : String(err))))
  })
}

async function poll($: EngineInterface): Promise<void> {
  const state = await current($)
  if (!state.record) return
  try {
    const auth = await $.session.authorize()
    if (!auth) throw new Error(t.noCredential)
    const res = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: USAGE_HEADERS })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const polled = parseUsageBody(res.text)
    if (polled.length === 0) throw new Error(t.badUsageBody)
    pollFailures = 0
    live = { ...(await current($)), polled }
    await check($)
  } catch (err) {
    pollFailures++
    if (pollFailures === POLL_FAILURES_BEFORE_NOTICE) {
      $.ui.toast(t.pollFailing(pollFailures, err instanceof Error ? err.message : String(err)))
    }
  }
}

// ---- env / fork / command ----

async function adoptFromEnv($: EngineInterface): Promise<void> {
  const raw = await $.env.get('CC_SESSION_BUDGET')
  if (!raw) return
  const budget = JSON.parse(raw) as Budget
  if (!isEmpty(budget)) await save($, budget)
}

async function pruneStale($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY_PREFIX)) continue
    const record = (await $.store.get(key)) as SessionRecord | undefined
    if (!record || now - record.updatedAt > STALE_MS) await $.store.delete(key)
  }
}

/**
 * A transcript's text, or its last lines when it is over the 4 MiB read limit: the platform's
 * own tool hands those back, PowerShell on Windows and `tail` elsewhere, each with the other as
 * a fallback. Throws when neither ran, so a fork that could not be matched is reported, not
 * taken for a fork with no parent.
 */
async function readTail($: EngineInterface, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    let failure = ''
    for (const argv of tailCommands(path, isWindows)) {
      try {
        const out = await $.process.run(argv, { timeoutMs: TAIL_TIMEOUT_MS })
        if (out.exitCode === 0) return out.stdout
        failure = `${argv[0]} exited ${out.exitCode}`
      } catch (err) {
        failure = `${argv[0]}: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    throw new Error(failure)
  }
}

async function inheritOnFork($: EngineInterface, transcriptPath: string): Promise<void> {
  const state = await current($)
  if (state.record) return
  const records: SessionRecord[] = []
  for (const key of await $.store.keys()) {
    if (key.startsWith(KEY_PREFIX)) records.push((await $.store.get(key)) as SessionRecord)
  }
  // No session holds a budget, so there is nothing to inherit: the transcript is not read at all.
  if (records.length === 0) return
  const forkUuids = uuidsOf(await readTail($, transcriptPath)).slice(-TAIL_LINES)
  const parent = findParent(forkUuids, records, state.sid)
  if (!parent) {
    $.ui.toast(t.forkNoParent)
    return
  }
  // Copying the spec as-is keeps the parent's ceiling: that is its remaining allowance.
  await save($, parent.budget)
  $.ui.toast(t.forkInherited(statusText(evaluate(parent.budget, []))?.replace('budget ', '') ?? ''))
}

/** Runs `/budget`. A change confirms by toast and prints nothing; show, help and errors print. */
async function runCommand($: EngineInterface, args: string): Promise<string | undefined> {
  const state = await current($)
  const budget = state.record?.budget ?? {}
  const cmd = parseCommand(t, args, budget)
  const readings = await readingsNow($)
  switch (cmd.kind) {
    case 'help':
      return t.usage
    case 'error':
      return `${cmd.message}\n${t.usage}`
    case 'off':
      await save($, withoutWindows(budget, cmd.windows))
      break
    case 'set':
      await save($, normalize(cmd.budget, readings))
      break
    case 'poll':
      await setPoll($, cmd.seconds)
      break
  }
  const after = (await current($)).record?.budget ?? {}
  if (isEmpty(after)) $.ui.status(undefined)
  else await check($, readings)
  const now = await current($)
  const info = { pending: await pendingNow($), pollSeconds: config.pollSeconds, costPerRequest: costs(now).five_hour, inFlight: now.inFlight }
  if (cmd.kind === 'show') return showText(t, after, readings, info)
  $.ui.toast(confirmText(t, cmd, after, readings, info))
  return undefined
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    t = messages(await pickLang($, options?.language))
    // immediate: typed while a turn is streaming it runs now, so the cap can be
    // raised or lowered mid-answer; the next turn.step reads the new budget.
    await $.command.register({
      name: 'budget',
      description: t.commandDescription,
      argumentHint: '5h<=70 week+5 | off | poll 90',
      immediate: true,
    })
    await loadConfig($)
    const state = await current($)
    if (!state.record) await adoptFromEnv($)
    await pruneStale($)
    await check($)
    syncPoll($)
    return next(e)
  }).catch(async ($, e, next) => (await fault($, 'session.start'), next(e)))

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'fork' && e.transcript_path) await inheritOnFork($, e.transcript_path)
    return next(e)
  }).catch(async ($, e, next) => (await fault($, t.forkFailed), next(e)))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && live) live = { ...live, carryOnClear: true }
    else {
      pollTimer?.cancel()
      pollTimer = undefined
    }
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && stored.uuid) {
      const state = await current($)
      const ring = pushRing(state.ring, stored.uuid)
      live = { ...state, ring }
      if (state.record) await $.store.set(KEY_PREFIX + state.sid, { ...state.record, ring })
    }
    return stored
  })

  on('turn.step', async function* ($, e, next) {
    let states: WindowState[]
    try {
      // The headers here are this session's last response: a cost sample point.
      await sampleCost($)
      states = await check($, undefined, 1)
    } catch (err) {
      await fault($, err)
      return yield* next(e)
    }
    if (worst(states) === 'over') {
      return { turnId: e.turnId, index: e.index, answer: blockMessage(t, states), toolUses: [], stopReason: 'end_turn', usage: null }
    }
    const started = await current($)
    live = { ...started, inFlight: started.inFlight + 1 }
    try {
      return yield* next(e)
    } finally {
      const done = await current($)
      live = { ...done, inFlight: Math.max(0, done.inFlight - 1), completed: done.completed + 1 }
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const states = await check($)
    return worst(states) === 'ok' ? next(e) : { deny: warnMessage(t, states) }
  }).catch(async ($, e, next) => (await fault($, 'agent.spawn'), next(e)))

  on('prompt.submit', async ($, e, next) => {
    if (e.text.trimStart().startsWith('/')) return next(e)
    const states = await check($)
    return worst(states) === 'over' ? { drop: blockMessage(t, states) } : next(e)
  }).catch(async ($, e, next) => (await fault($, 'prompt.submit'), next(e)))

  on('session.measure', async ($, e, next) => {
    await sampleCost($, e.rateLimits)
    await check($, mergeReadings(e.rateLimits, (await current($)).polled))
    return next(e)
  }).catch(async ($, e, next) => (await fault($, 'session.measure'), next(e)))

  on('command.run', { command: 'budget' }, async ($, e) => ({ text: await runCommand($, e.args) }))
}
