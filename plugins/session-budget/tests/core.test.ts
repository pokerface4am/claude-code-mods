import { describe, expect, test } from 'claude-code/testing'

import { blockMessage, ceilingOf, confirmText, COST_SPAN, costPerRequest, evaluate, findParent, mergeReadings, normalize, parseCommand, parseUsageBody, pendingFor, pushRing, pushSample, showText, statusText, TAIL_LINES, tailCommands, uuidsOf, warnMessage, withoutWindows, worst } from '../hooks/core'
import type { CostSample, Reading, SessionRecord } from '../hooks/core'
import { fixedLang, langOfLocale, messages } from '../hooks/messages'

/** The Chinese and the English words: every text test below says which it reads. */
const T = messages('zh')
const E = messages('en')

const AT5 = '2026-10-06T13:20:00.000Z'

const R = (fiveHour: number, week: number, fiveAt = '2026-10-06T13:20:00.000Z'): Reading[] => [
  { kind: 'five_hour', percentUsed: fiveHour, resetsAt: fiveAt },
  { kind: 'seven_day', percentUsed: week, resetsAt: '2026-10-06T19:00:00.000Z' },
]

describe('parseCommand', () => {
  test('empty args show', () => {
    expect(parseCommand(T, '', {})).toEqual({ kind: 'show' })
  })
  test('absolute and relative tokens combine per window', () => {
    expect(parseCommand(T, '5h<=70 5h+20 week+5', {})).toEqual({
      kind: 'set',
      budget: { five_hour: { abs: 70, rel: { amount: 20 } }, seven_day: { rel: { amount: 5 } } },
    })
  })
  test('aliases and % suffix', () => {
    expect(parseCommand(T, 'wk<=60% 7d+3', {})).toEqual({ kind: 'set', budget: { seven_day: { abs: 60, rel: { amount: 3 } } } })
  })
  test('keeps windows not mentioned', () => {
    expect(parseCommand(T, 'week<=60', { five_hour: { abs: 50 } })).toEqual({
      kind: 'set',
      budget: { five_hour: { abs: 50 }, seven_day: { abs: 60 } },
    })
  })
  test('a later command replaces the line of a window it names, of either kind', () => {
    // At a relative line of 57, `5h<=80` used to keep the 57 (the lower of the two) and so raised nothing.
    const relative = { five_hour: { rel: { amount: 20, baseline: 37 } } }
    expect(parseCommand(T, '5h<=80', relative)).toEqual({ kind: 'set', budget: { five_hour: { abs: 80 } } })
    expect(ceilingOf((parseCommand(T, '5h<=80', relative) as { budget: { five_hour: object } }).budget.five_hour)).toBe(80)
    expect(parseCommand(T, '5h+20', { five_hour: { abs: 70 } })).toEqual({ kind: 'set', budget: { five_hour: { rel: { amount: 20 } } } })
    expect(parseCommand(T, '5h<=70 5h+20', { five_hour: { abs: 90 }, seven_day: { abs: 60 } })).toEqual({
      kind: 'set',
      budget: { five_hour: { abs: 70, rel: { amount: 20 } }, seven_day: { abs: 60 } },
    })
  })
  test('rejects garbage and out-of-range', () => {
    expect(parseCommand(T, '5h=70', {}).kind).toBe('error')
    expect(parseCommand(T, '5h<=0', {}).kind).toBe('error')
    expect(parseCommand(T, '5h<=150', {}).kind).toBe('error')
    expect(parseCommand(T, 'off fable', {}).kind).toBe('error')
  })
  test('off clears one or all windows', () => {
    expect(parseCommand(T, 'off 5h', {})).toEqual({ kind: 'off', windows: ['five_hour'] })
    expect(parseCommand(T, 'off', {})).toEqual({ kind: 'off', windows: ['five_hour', 'seven_day'] })
    expect(withoutWindows({ five_hour: { abs: 1 }, seven_day: { abs: 2 } }, ['five_hour'])).toEqual({ seven_day: { abs: 2 } })
  })
})

describe('normalize and evaluate', () => {
  test('relative baseline fills from the first reading', () => {
    const b = normalize({ five_hour: { rel: { amount: 20 } } }, R(6, 57))
    expect(b.five_hour?.rel).toEqual({ amount: 20, baseline: 6, resetsAt: '2026-10-06T13:20:00.000Z' })
    expect(ceilingOf(b.five_hour)).toBe(26)
  })
  test('no reading leaves the budget untouched and evaluates ok', () => {
    const b = { five_hour: { rel: { amount: 20 } } }
    expect(normalize(b, [])).toBe(b)
    expect(worst(evaluate(b, []))).toBe('ok')
  })
  test('the lower of absolute and relative wins', () => {
    expect(ceilingOf({ abs: 70, rel: { amount: 20, baseline: 6 } })).toBe(26)
    expect(ceilingOf({ abs: 20, rel: { amount: 20, baseline: 6 } })).toBe(20)
  })
  test('warn within 2 points, over at the ceiling', () => {
    const b = { five_hour: { abs: 30 } }
    expect(worst(evaluate(b, R(27, 0)))).toBe('ok')
    expect(worst(evaluate(b, R(28, 0)))).toBe('warn')
    expect(worst(evaluate(b, R(30, 0)))).toBe('over')
  })
  test('either window over is over', () => {
    expect(worst(evaluate({ five_hour: { abs: 90 }, seven_day: { abs: 50 } }, R(10, 57)))).toBe('over')
  })
  test('a reset window gets a fresh relative allowance', () => {
    const b = normalize({ five_hour: { rel: { amount: 20 } } }, R(30, 0))
    expect(worst(evaluate(b, R(50, 0)))).toBe('over')
    const after = normalize(b, R(1, 0, '2026-10-06T18:20:00.000Z'))
    expect(after.five_hour?.rel?.baseline).toBe(1)
    expect(worst(evaluate(after, R(1, 0, '2026-10-06T18:20:00.000Z')))).toBe('ok')
  })
  test('a small resetsAt jitter is not a reset', () => {
    const b = normalize({ five_hour: { rel: { amount: 20 } } }, R(30, 0))
    expect(normalize(b, R(45, 0, '2026-10-06T13:21:00.000Z')).five_hour?.rel?.baseline).toBe(30)
  })
})

describe('fork lookup', () => {
  const rec = (sessionId: string, ring: string[], updatedAt: number): SessionRecord => ({
    sessionId, ring, updatedAt, budget: { five_hour: { abs: 50 } },
  })
  const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

  test('uuidsOf reads row uuids in order, not parentUuid', () => {
    const text = `{"parentUuid":"${u(1)}","uuid":"${u(2)}","x":1}\n{"parentUuid":"${u(2)}","uuid":"${u(3)}"}\n`
    expect(uuidsOf(text)).toEqual([u(2), u(3)])
  })
  test('picks the record holding the latest copied uuid', () => {
    const grand = rec('g', [u(1), u(2)], 1)
    const parent = rec('p', [u(3), u(4)], 2)
    expect(findParent([u(1), u(2), u(3), u(4), u(9)], [grand, parent], 'self')?.sessionId).toBe('p')
  })
  test('ignores itself and returns undefined with no match', () => {
    expect(findParent([u(1)], [rec('self', [u(1)], 1)], 'self')).toBeUndefined()
  })
  test('ring keeps the newest, bounded', () => {
    let ring: string[] = []
    for (let i = 0; i < 100; i++) ring = pushRing(ring, u(i))
    expect(ring.length).toBe(64)
    expect(ring[63]).toBe(u(99))
  })
})

describe('account usage polling', () => {
  test('parseUsageBody reads five_hour / seven_day and ignores the rest', () => {
    const body = JSON.stringify({
      five_hour: { utilization: 35.0, resets_at: '2026-10-22T13:40:00+00:00', limit_dollars: null },
      seven_day: { utilization: 25, resets_at: '2026-10-27T19:00:00+00:00' },
      seven_day_opus: null,
      limits: [{ kind: 'weekly_scoped', percent: 43 }],
    })
    expect(parseUsageBody(body)).toEqual([
      { kind: 'five_hour', percentUsed: 35, resetsAt: '2026-10-22T13:40:00+00:00' },
      { kind: 'seven_day', percentUsed: 25, resetsAt: '2026-10-27T19:00:00+00:00' },
    ])
    expect(parseUsageBody('not json')).toEqual([])
    expect(parseUsageBody('{"five_hour":{"utilization":"x"}}')).toEqual([])
  })

  test('mergeReadings: the higher figure within a window, the newer window after a reset', () => {
    const h = [{ kind: 'five_hour', percentUsed: 35.4, resetsAt: AT5 }, { kind: 'spend_limit', percentUsed: 3 }]
    expect(mergeReadings(h, [{ kind: 'five_hour', percentUsed: 35, resetsAt: AT5 }])).toEqual(h)
    expect(mergeReadings(h, [{ kind: 'five_hour', percentUsed: 41, resetsAt: AT5 }])[0]!.percentUsed).toBe(41)
    const later = '2026-10-06T18:20:00.000Z'
    expect(mergeReadings(h, [{ kind: 'five_hour', percentUsed: 2, resetsAt: later }])[0]!.percentUsed).toBe(2)
    expect(mergeReadings([], [{ kind: 'seven_day', percentUsed: 9 }])).toEqual([{ kind: 'seven_day', percentUsed: 9 }])
  })
})

describe('per-request cost estimate', () => {
  test('costPerRequest is the rise per completion over the kept samples', () => {
    let s: CostSample[] = []
    s = pushSample(s, { completed: 0, used: 10, resetsAt: AT5 })
    expect(costPerRequest(s)).toBe(0)
    s = pushSample(s, { completed: 1, used: 12, resetsAt: AT5 })
    s = pushSample(s, { completed: 2, used: 13, resetsAt: AT5 })
    expect(costPerRequest(s)).toBe(1.5)
    // The same completion count twice keeps the later (higher) reading.
    s = pushSample(s, { completed: 2, used: 14, resetsAt: AT5 })
    expect(s.length).toBe(3)
    expect(costPerRequest(s)).toBe(2)
  })

  test('a reset or a falling reading starts the series over; old samples drop past COST_SPAN', () => {
    let s: CostSample[] = []
    for (let i = 0; i <= COST_SPAN + 3; i++) s = pushSample(s, { completed: i, used: 10 + i, resetsAt: AT5 })
    expect(s[0]!.completed).toBe(3)
    expect(costPerRequest(s)).toBe(1)
    s = pushSample(s, { completed: 20, used: 1, resetsAt: '2026-10-06T18:20:00.000Z' })
    expect(s).toEqual([{ completed: 20, used: 1, resetsAt: '2026-10-06T18:20:00.000Z' }])
    s = pushSample(s, { completed: 21, used: 0.5, resetsAt: '2026-10-06T18:20:00.000Z' })
    expect(s.length).toBe(1)
  })

  test('evaluate counts the pending estimate toward the ceiling', () => {
    const budget = { five_hour: { abs: 70 } }
    const readings = [{ kind: 'five_hour', percentUsed: 68.5 }]
    expect(evaluate(budget, readings)[0]!.level).toBe('warn')
    expect(evaluate(budget, readings, pendingFor({ five_hour: 1.2 }, 1))[0]!.level).toBe('warn')
    expect(evaluate(budget, readings, pendingFor({ five_hour: 1.3 }, 2))[0]!.level).toBe('over')
    expect(pendingFor({ five_hour: 2 }, 0)).toEqual({})
    expect(statusText(evaluate(budget, readings, { five_hour: 2.6 }))).toBe('budget ⛔5h 68.5+2.6/70')
  })
})

describe('messages in Chinese and in English', () => {
  const budget = { five_hour: { abs: 70 }, seven_day: { rel: { amount: 5, baseline: 57 } } }

  test('the stop and the warning', () => {
    const over = evaluate({ five_hour: { abs: 70 } }, [{ kind: 'five_hour', percentUsed: 68.5 }], { five_hour: 2.6 })
    expect(blockMessage(T, over)).toBe(
      '[session-budget] 本 session 已触顶：5h 已用 68.5%，在途请求预计再加 2.6（上限 70%）。已停止发送模型请求；用 /budget 查看，/budget 5h<=N 调高或 /budget off 关闭后继续。',
    )
    expect(blockMessage(E, over)).toBe(
      '[session-budget] This session reached its cap: 5h at 68.5%, requests in flight expected to add 2.6 (cap 70%). No more model requests are sent. Run /budget to see it; raise it with /budget 5h<=N or turn it off with /budget off to go on.',
    )
    // The hint names the window that hit its cap.
    const weekOver = evaluate({ five_hour: { abs: 90 }, seven_day: { abs: 60 } }, R(10, 61))
    expect(blockMessage(T, weekOver)).toContain('/budget week<=N 调高')
    expect(blockMessage(E, weekOver)).toContain('raise it with /budget week<=N')
    const near = evaluate({ five_hour: { abs: 30 } }, R(28, 0))
    expect(warnMessage(T, near)).toBe('[session-budget] 接近上限（5h 28/30），不再派新的 subagent。')
    expect(warnMessage(E, near)).toBe('[session-budget] Close to the cap (5h 28/30): no new subagents.')
  })

  test('what /budget prints and what a change confirms with', () => {
    const readings = R(10, 57)
    const info = { pollSeconds: 90, costPerRequest: 1.5, inFlight: 2 }
    expect(showText(T, budget, readings, info)).toBe(
      '5h 10/70 [绝对 ≤70] 正常 · week 57/62 [相对 +5（基线 57）] 正常\n轮询 90 秒 · 单请求约 1.5 点（5h） · 在途 2 · /budget help 看用法',
    )
    expect(showText(E, budget, readings, info)).toBe(
      '5h 10/70 [absolute ≤70] ok · week 57/62 [relative +5 (baseline 57)] ok\npolling every 90s · about 1.5 points per request (5h) · 2 in flight · /budget help for usage',
    )
    expect(showText(T, {}, readings)).toBe('本 session 未设上限（不轮询）。/budget help 看用法')
    expect(showText(E, {}, readings)).toBe('No cap on this session (not polling). /budget help for usage')
    expect(confirmText(T, { kind: 'set', budget }, { five_hour: { abs: 70 } }, readings)).toBe('[session-budget] 上限已更新：5h 10/70 [绝对 ≤70] 正常')
    expect(confirmText(E, { kind: 'set', budget }, { five_hour: { abs: 70 } }, readings)).toBe('[session-budget] Cap updated: 5h 10/70 [absolute ≤70] ok')
    expect(confirmText(E, { kind: 'poll', seconds: 30 }, budget, readings)).toBe('[session-budget] Polling every 30s')
    expect(confirmText(E, { kind: 'poll', seconds: 0 }, budget, readings)).toBe('[session-budget] Polling off')
    expect(confirmText(E, { kind: 'off', windows: ['five_hour', 'seven_day'] }, {}, readings)).toBe('[session-budget] Cap removed')
  })

  test('an argument error names the bad token', () => {
    expect(parseCommand(T, '5h=70', {})).toEqual({ kind: 'error', message: '看不懂「5h=70」。格式：5h<=70（绝对线）或 5h+20（相对额度），窗口 5h / week' })
    expect(parseCommand(E, '5h=70', {})).toEqual({
      kind: 'error',
      message: `Can't read "5h=70". Write 5h<=70 (absolute line) or 5h+20 (relative allowance); the windows are 5h and week`,
    })
    expect(parseCommand(E, 'off fable', {})).toEqual({ kind: 'error', message: 'Unknown window: fable (use 5h or week)' })
    expect(parseCommand(E, 'poll 5', {})).toEqual({ kind: 'error', message: 'poll takes seconds (15–3600) or off, e.g. /budget poll 90' })
    expect(parseCommand(E, '5h<=150', {})).toEqual({ kind: 'error', message: 'The value in "5h<=150" must be between 0 and 100' })
  })

  test('both tables hold the same entries', () => {
    expect(Object.keys(E).sort()).toEqual(Object.keys(T).sort())
    expect(Object.keys(E.level).sort()).toEqual(Object.keys(T.level).sort())
  })

  test('the language is the option when it names one, else the locale, else English', () => {
    expect(fixedLang('zh')).toBe('zh')
    expect(fixedLang('en')).toBe('en')
    expect(fixedLang('auto')).toBeUndefined()
    expect(fixedLang(undefined)).toBeUndefined()
    expect(langOfLocale([undefined, undefined, 'zh_CN.UTF-8'])).toBe('zh')
    expect(langOfLocale(['', 'zh-TW', 'en_US.UTF-8'])).toBe('zh')
    expect(langOfLocale(['en_US.UTF-8', undefined, 'zh_CN.UTF-8'])).toBe('en')
    expect(langOfLocale([undefined, undefined, undefined])).toBe('en')
    expect(langOfLocale(['C'])).toBe('en')
  })
})

describe('transcript tail', () => {
  test('the platform tool first, the other as a fallback; a quote in the path is doubled for PowerShell', () => {
    const [first, second] = tailCommands("C:\\it's\\t.jsonl", true)
    expect(first).toEqual(['powershell', '-NoProfile', '-Command', `Get-Content -LiteralPath 'C:\\it''s\\t.jsonl' -Tail ${TAIL_LINES} -Encoding UTF8`])
    expect(second).toEqual(['tail', '-n', '400', "C:\\it's\\t.jsonl"])
    const unix = tailCommands('/home/a b/t.jsonl', false)
    expect(unix.map(argv => argv[0])).toEqual(['tail', 'powershell'])
    expect(unix[0]).toEqual(['tail', '-n', '400', '/home/a b/t.jsonl'])
  })
})
