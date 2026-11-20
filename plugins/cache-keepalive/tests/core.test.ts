import { describe, expect, test } from 'claude-code/testing'

import {
  applyCommand,
  decide,
  DEFAULTS,
  describe as describeState,
  hitOf,
  MINUTE_MS,
  parseArgs,
  pingReport,
  readOptions,
  isIdleCompactionOn,
  shouldTurnIdleCompactionOff,
  shortText,
  statusText,
} from '../hooks/core'
import type { Situation } from '../hooks/core'
import { fixedLang, langOfLocale, messages } from '../hooks/messages'

/** The Chinese and the English words: every text test below says which it reads. */
const T = messages('zh')
const E = messages('en')

const M = MINUTE_MS

function sit(over: Partial<Situation>): Situation {
  return { plan: { max: 3, used: 0 }, lastApiAt: 0, now: 0, retryFrom: null, isTurnRunning: false, ...over }
}

describe('parseArgs', () => {
  test('empty is status; off/stop/0 are off; on is the default max', () => {
    expect(parseArgs(T, '', 3)).toEqual({ kind: 'status' })
    expect(parseArgs(T, '  ', 3)).toEqual({ kind: 'status' })
    expect(parseArgs(T, 'off', 3)).toEqual({ kind: 'off' })
    expect(parseArgs(T, 'STOP', 3)).toEqual({ kind: 'off' })
    expect(parseArgs(T, '0', 3)).toEqual({ kind: 'off' })
    expect(parseArgs(T, 'on', 4)).toEqual({ kind: 'set', max: 4 })
  })

  test('a number sets, +N adds, anything else is help', () => {
    expect(parseArgs(T, '5', 3)).toEqual({ kind: 'set', max: 5 })
    expect(parseArgs(T, ' +2 ', 3)).toEqual({ kind: 'add', count: 2 })
    expect(parseArgs(T, '+0', 3).kind).toBe('help')
    expect(parseArgs(T, '-1', 3).kind).toBe('help')
    expect(parseArgs(T, '3h', 3).kind).toBe('help')
  })
})

describe('applyCommand', () => {
  test('set keeps the count, add raises the cap, add while off arms', () => {
    expect(applyCommand(null, { kind: 'set', max: 2 })).toEqual({ max: 2, used: 0 })
    expect(applyCommand({ max: 3, used: 2 }, { kind: 'set', max: 5 })).toEqual({ max: 5, used: 2 })
    expect(applyCommand({ max: 3, used: 3 }, { kind: 'add', count: 2 })).toEqual({ max: 5, used: 3 })
    expect(applyCommand(null, { kind: 'add', count: 2 })).toEqual({ max: 2, used: 0 })
    expect(applyCommand({ max: 3, used: 1 }, { kind: 'off' })).toBe(null)
    expect(applyCommand({ max: 3, used: 1 }, { kind: 'status' })).toEqual({ max: 3, used: 1 })
  })
})

describe('readOptions', () => {
  test('defaults fill in anything missing or invalid', () => {
    expect(readOptions(undefined)).toEqual(DEFAULTS)
    expect(readOptions({ intervalMinutes: -5, cacheTtlMinutes: 'x', defaultMax: 0 })).toEqual(DEFAULTS)
    expect(readOptions({ intervalMinutes: 20, defaultMax: 2.4 })).toEqual({ ...DEFAULTS, intervalMinutes: 20, defaultMax: 2 })
  })

  test('disableIdleCompaction is on unless it is set to false', () => {
    expect(DEFAULTS.disableIdleCompaction).toBe(true)
    expect(readOptions({}).disableIdleCompaction).toBe(true)
    expect(readOptions({ disableIdleCompaction: 'nonsense' }).disableIdleCompaction).toBe(true)
    expect(readOptions({ disableIdleCompaction: false }).disableIdleCompaction).toBe(false)
    expect(readOptions({ disableIdleCompaction: 'false' }).disableIdleCompaction).toBe(false)
  })
})

describe('idle compaction', () => {
  const layer = (source: string, settings: Record<string, unknown>) => ({ source, settings })

  test('reads as off when the option is on and nothing mentions it', () => {
    expect(shouldTurnIdleCompactionOff(true, {}, [])).toBe(true)
    expect(shouldTurnIdleCompactionOff(true, { model: 'opus' }, [layer('user', { model: 'opus' }), layer('project', {})])).toBe(true)
  })

  test('a value written in any settings source stands, on or off', () => {
    expect(shouldTurnIdleCompactionOff(true, { idleCompaction: true }, [layer('user', { idleCompaction: true })])).toBe(false)
    expect(shouldTurnIdleCompactionOff(true, { idleCompaction: false }, [layer('user', {}), layer('policy', { idleCompaction: false })])).toBe(false)
  })

  test('the merged settings alone are enough to see a written value, and so is one layer alone', () => {
    expect(shouldTurnIdleCompactionOff(true, { idleCompaction: true }, [])).toBe(false)
    expect(shouldTurnIdleCompactionOff(true, {}, [layer('user', { idleCompaction: true })])).toBe(false)
  })

  test('with the option off the settings are never touched', () => {
    expect(shouldTurnIdleCompactionOff(false, {}, [])).toBe(false)
  })
})

describe('decide', () => {
  test('off, running, exhausted and no anchor each stop it', () => {
    expect(decide(sit({ plan: null }), DEFAULTS)).toEqual({ kind: 'off' })
    expect(decide(sit({ isTurnRunning: true }), DEFAULTS)).toEqual({ kind: 'running' })
    expect(decide(sit({ plan: { max: 2, used: 2 } }), DEFAULTS)).toEqual({ kind: 'exhausted' })
    expect(decide(sit({ lastApiAt: null }), DEFAULTS)).toEqual({ kind: 'no-anchor' })
  })

  test('fires interval minutes after the last request, at once when overdue', () => {
    expect(decide(sit({ lastApiAt: 10 * M, now: 12 * M }), DEFAULTS)).toEqual({ kind: 'fire', delayMs: 48 * M })
    expect(decide(sit({ lastApiAt: 0, now: 55 * M }), DEFAULTS)).toEqual({ kind: 'fire', delayMs: 0 })
  })

  test('past the TTL it is expired, and a retry that would land past the TTL too', () => {
    expect(decide(sit({ lastApiAt: 0, now: 60 * M }), DEFAULTS)).toEqual({ kind: 'expired', elapsedMs: 60 * M })
    expect(decide(sit({ lastApiAt: 0, now: 52 * M, retryFrom: 50 * M }), DEFAULTS)).toEqual({ kind: 'fire', delayMs: 3 * M })
    expect(decide(sit({ lastApiAt: 0, now: 57 * M, retryFrom: 56 * M }), DEFAULTS).kind).toBe('expired')
  })
})

describe('text', () => {
  test('status line follows the decision; off clears it', () => {
    expect(statusText(T, null, { kind: 'off' })).toBe(undefined)
    expect(statusText(T, { max: 3, used: 1 }, { kind: 'fire', delayMs: 42 * M })).toBe('keepalive 1/3 · 42m 后续命')
    expect(statusText(T, { max: 3, used: 1 }, { kind: 'fire', delayMs: 90 * M })).toBe('keepalive 1/3 · 1h30 后续命')
    expect(statusText(T, { max: 3, used: 3 }, { kind: 'exhausted' })).toBe('keepalive 3/3 · 已用完')
    expect(statusText(T, { max: 3, used: 0 }, { kind: 'running' })).toBe('keepalive 0/3 · 等本轮结束')
  })

  test('a ping report says what the cache served', () => {
    const warm = hitOf({ input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0 })
    expect(warm.ratio).toBeGreaterThan(0.99)
    expect(pingReport(T, { max: 3, used: 1 }, warm)).toBe('keepalive 1/3：已续命，cache 命中 120k/120k tokens（100%）')
    const cold = hitOf({ input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_000 })
    expect(pingReport(T, { max: 3, used: 2 }, cold)).toBe('keepalive 2/3：cache 未命中（0%），已重新写入 80k tokens')
  })
})

describe('messages in English', () => {
  const plan = { max: 3, used: 1 }

  test('the status line and the one-line answer', () => {
    expect(statusText(E, plan, { kind: 'fire', delayMs: 42 * M })).toBe('keepalive 1/3 · next ping in 42m')
    expect(statusText(E, plan, { kind: 'fire', delayMs: 0 })).toBe('keepalive 1/3 · pinging')
    expect(statusText(E, { max: 3, used: 3 }, { kind: 'exhausted' })).toBe('keepalive 3/3 · used up')
    expect(statusText(E, plan, { kind: 'running' })).toBe('keepalive 1/3 · waiting for this turn')
    expect(statusText(E, plan, { kind: 'no-anchor' })).toBe('keepalive 1/3 · waiting for the first turn')
    expect(statusText(E, plan, { kind: 'expired', elapsedMs: 65 * M })).toBe('keepalive 1/3 · cache expired')
    expect(shortText(E, plan, { kind: 'fire', delayMs: 50 * M })).toBe('keepalive on 1/3 · next ping in 50m')
    expect(shortText(E, null, { kind: 'off' })).toBe('keepalive off')
    expect(shortText(T, plan, { kind: 'fire', delayMs: 50 * M })).toBe('keepalive 已开启 1/3 · 50m 后续命')
    expect(shortText(T, null, { kind: 'off' })).toBe('keepalive 已关闭')
  })

  test('the full state of a bare /keepalive', () => {
    expect(describeState(E, null, { kind: 'off' }, DEFAULTS, false)).toBe(
      'keepalive is off. Arm it with /keepalive N (default N=3). Interval 50 min, changed in /config.\nIdle compaction is off: an idle conversation is not replaced by a summary.',
    )
    expect(describeState(E, plan, { kind: 'fire', delayMs: 42 * M }, DEFAULTS, false)).toBe(
      'keepalive is on: 1/3 pings used during this absence.\nNext ping in 42m.\nInterval 50 min, TTL taken as 60 min.\nIdle compaction is off: an idle conversation is not replaced by a summary.',
    )
    expect(describeState(E, plan, { kind: 'expired', elapsedMs: 65 * M }, DEFAULTS, false)).toContain('The last request was 1h05 ago and the cache has expired')
    expect(describeState(T, plan, { kind: 'fire', delayMs: 42 * M }, DEFAULTS, false)).toBe(
      'keepalive 开启：本次离开期间已续 1/3 次。\n下一次续命在 42m 后。\n间隔 50 分钟，TTL 按 60 分钟算。\nidle compaction 已关闭：对话闲置时不会被压成摘要。',
    )
  })

  test('the last line of the full state warns when idle compaction is on', () => {
    expect(describeState(E, plan, { kind: 'fire', delayMs: 42 * M }, DEFAULTS, true).split('\n').at(-1)).toBe(
      'Idle compaction is on: a long conversation left idle for about an hour is replaced by a summary. To keep the full conversation, turn it off in /config.',
    )
    expect(describeState(T, null, { kind: 'off' }, DEFAULTS, true).split('\n').at(-1)).toBe(
      'idle compaction 开着：长对话闲置约一小时会被压成摘要。要保留完整对话，在 /config 里把它关掉。',
    )
  })

  test('a ping report and an argument error', () => {
    const warm = hitOf({ input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0 })
    expect(pingReport(E, plan, warm)).toBe('keepalive 1/3: cache kept warm, 120k/120k tokens read from cache (100%)')
    const cold = hitOf({ input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 80_000 })
    expect(pingReport(E, { max: 3, used: 2 }, cold)).toBe('keepalive 2/3: cache miss (0%), 80k tokens written again')
    expect(parseArgs(E, '3h', 3)).toEqual({ kind: 'help', error: `Can't read "3h"` })
    expect(parseArgs(E, '+0', 3)).toEqual({ kind: 'help', error: '+0 does nothing' })
    expect(parseArgs(T, '3h', 3)).toEqual({ kind: 'help', error: '看不懂「3h」' })
  })

  test('both tables hold the same entries', () => {
    expect(Object.keys(E).sort()).toEqual(Object.keys(T).sort())
  })

  test('the language is the option when it names one, else the locale, else English', () => {
    expect(fixedLang('zh')).toBe('zh')
    expect(fixedLang('en')).toBe('en')
    expect(fixedLang('auto')).toBeUndefined()
    expect(fixedLang(undefined)).toBeUndefined()
    expect(langOfLocale([undefined, undefined, 'zh_CN.UTF-8'])).toBe('zh')
    expect(langOfLocale(['en_US.UTF-8', undefined, 'zh_CN.UTF-8'])).toBe('en')
    expect(langOfLocale([undefined, undefined, undefined])).toBe('en')
  })
})

describe('how idle compaction reads with the mod loaded', () => {
  test('nothing written: the option decides', () => {
    expect(isIdleCompactionOn(true, undefined)).toBe(false)
    expect(isIdleCompactionOn(false, undefined)).toBe(true)
  })

  test('a written value decides, whatever the option', () => {
    expect(isIdleCompactionOn(true, true)).toBe(true)
    expect(isIdleCompactionOn(true, false)).toBe(false)
    expect(isIdleCompactionOn(false, false)).toBe(false)
  })
})
