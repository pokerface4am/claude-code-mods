import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  applyCommand,
  COLD_RATIO,
  decide,
  describe,
  hitOf,
  MINUTE_MS,
  minutes,
  parseArgs,
  pingReport,
  PING_PROMPT,
  readOptions,
  shortText,
  statusText,
} from './core'
import type { Decision, Options, Situation } from './core'
import { fixedLang, langOfLocale, messages } from './messages'
import type { Lang, Messages } from './messages'
import type { KeepalivePlan } from '../types'

const PLAN = { plugin: 'cache-keepalive', key: 'plan' } as const
const LAST = { plugin: 'cache-keepalive', key: 'lastApiAt' } as const
const LATEST = { plugin: 'cache-keepalive', key: 'latestText' } as const

/** What the module keeps between dispatches; lost on a reload, rebuilt by `session.start` from `$.state`. */
type Runtime = {
  o: Options
  /** The words of this session's messages; set from the `language` option at session.start. */
  t: Messages
  timer: Timer | null
  ticker: Timer | null
  isTurnRunning: boolean
  isPinging: boolean
  retryFrom: number | null
}

async function situation($: EngineInterface, rt: Runtime): Promise<Situation> {
  const [plan, last, now] = await Promise.all([$.state.get(PLAN), $.state.get(LAST), $.clock.now()])
  return {
    plan: plan.value ?? null,
    lastApiAt: last.value ?? null,
    now,
    retryFrom: rt.retryFrom,
    isTurnRunning: rt.isTurnRunning,
  }
}

function stopTimers(rt: Runtime): void {
  rt.timer?.cancel()
  rt.timer = null
  rt.ticker?.cancel()
  rt.ticker = null
}

/** Re-reads the state, arms (or disarms) the timer and redraws the status line. */
async function reschedule($: EngineInterface, rt: Runtime): Promise<Decision> {
  stopTimers(rt)
  const s = await situation($, rt)
  const d = decide(s, rt.o)
  if (d.kind === 'fire') {
    rt.timer = $.clock.after(d.delayMs, () => void ping($, rt))
    rt.ticker = $.clock.every(MINUTE_MS, () => void refreshStatus($, rt))
  }
  $.ui.status(statusText(rt.t, s.plan, d))
  return d
}

async function refreshStatus($: EngineInterface, rt: Runtime): Promise<void> {
  const s = await situation($, rt)
  $.ui.status(statusText(rt.t, s.plan, decide(s, rt.o)))
}

/** The `language` option when it names a language; under `auto`, the locale's (LC_ALL, LC_MESSAGES, LANG). */
async function pickLang($: EngineInterface, option: unknown): Promise<Lang> {
  return fixedLang(option) ?? langOfLocale([await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')])
}

/** One keep-alive ping: a tool-less fork over the main thread's last request. */
async function ping($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isPinging) return
  rt.isPinging = true
  try {
    await pingOnce($, rt)
  } finally {
    rt.isPinging = false
  }
  await reschedule($, rt)
}

async function pingOnce($: EngineInterface, rt: Runtime): Promise<void> {
  const s = await situation($, rt)
  const d = decide(s, rt.o)
  if (d.kind !== 'fire' || d.delayMs > 0 || s.plan === null) return
  const plan: KeepalivePlan = { ...s.plan, used: s.plan.used + 1 }
  await $.state.set(PLAN, plan)
  const startedAt = s.now
  const r = await $.model.fork({ prompt: PING_PROMPT })
  if (r.isAnswered) {
    const hit = hitOf(r.usage)
    $.ui.log(pingReport(rt.t, plan, hit))
    if (hit.ratio < COLD_RATIO) {
      // The cache was gone before the ping: the TTL is shorter than the interval, or the model
      // changed. Pinging on would re-write the whole context each time, so stop here.
      await $.state.set(PLAN, null)
      $.ui.log(rt.t.coldOff(minutes(s.now - (s.lastApiAt ?? s.now))))
      return
    }
    rt.retryFrom = null
    await $.state.set(LAST, startedAt)
  } else if (r.reason === 'nothing-to-fork') {
    await $.state.set(PLAN, null)
    $.ui.log(rt.t.nothingToFork)
  } else {
    rt.retryFrom = await $.clock.now()
    const why = r.reason === 'api-error' ? `api-error ${r.status ?? '?'} ${r.error}` : r.reason
    $.ui.log(rt.t.pingFailed(`keepalive ${plan.used}/${plan.max}`, why, rt.o.retryMinutes))
  }
}

/** Runs one /keepalive: applies the arguments, re-arms, and answers one line (the full state for a bare /keepalive). */
async function runCommand($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  const cmd = parseArgs(rt.t, args, rt.o.defaultMax)
  if (cmd.kind === 'help') return `${cmd.error}\n${rt.t.usage}`
  if (cmd.kind !== 'status') {
    const before = await situation($, rt)
    await $.state.set(PLAN, applyCommand(before.plan, cmd))
  }
  const d = await reschedule($, rt)
  const s = await situation($, rt)
  return cmd.kind === 'status' ? describe(rt.t, s.plan, d, rt.o) : shortText(rt.t, s.plan, d)
}

export const register: Register = (on, rawOptions) => {
  const rt: Runtime = {
    o: readOptions(rawOptions),
    t: messages('en'),
    timer: null,
    ticker: null,
    isTurnRunning: false,
    isPinging: false,
    retryFrom: null,
  }

  on('session.start', async ($, e, next) => {
    rt.t = messages(await pickLang($, rawOptions?.language))
    await $.command.register({
      name: 'keepalive',
      description: rt.t.commandDescription,
      argumentHint: 'N | +N | on | off',
      immediate: true,
    })
    rt.isTurnRunning = false
    rt.retryFrom = null
    await reschedule($, rt)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopTimers(rt)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      rt.isTurnRunning = true
      await reschedule($, rt)
    }
    return next(e)
  })

  // The cache is refreshed when a main-thread request goes out: that moment anchors the timer.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) await $.state.set(LAST, await $.clock.now())
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      rt.isTurnRunning = false
      rt.retryFrom = null
      const s = await situation($, rt)
      if (s.plan !== null && s.plan.used !== 0) await $.state.set(PLAN, { ...s.plan, used: 0 })
      if (s.lastApiAt === null) await $.state.set(LAST, s.now)
      await reschedule($, rt)
    }
    return next(e)
  })

  // After a compaction the main thread's prefix is new; the old one is not worth pinging.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      await $.state.set(LAST, null)
      await reschedule($, rt)
    }
    return r
  })

  on('command.run', { command: 'keepalive' }, async ($, e) => {
    const text = await runCommand($, rt, e.args)
    await $.state.set(LATEST, text)
    return { text }
  })

  // Only the latest /keepalive output row stays on screen; every older one collapses to nothing.
  on('ui.render', { component: 'CommandOutput', props: { command: 'keepalive' } }, async ($, e, next) => {
    const latest = (await $.state.get(LATEST)).value ?? null
    if (e.props.isErrored || latest === null || e.props.text.includes(latest)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
}
