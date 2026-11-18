import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type World = {
  readings: { kind: string; percentUsed: number; resetsAt?: string }[]
  sid: string
  env: Record<string, string | undefined>
  toasts: string[]
  status: (string | undefined)[]
  requests: number
  files: Record<string, string>
  registered: { name: string; description?: string; immediate?: true }[]
  clock: ReturnType<typeof mock.clock>
  fetches: { url: string; auth?: string }[]
  usageBody: string | undefined
  authorized: boolean
  /** Every argv handed to process.run, in order. */
  runs: string[][]
  /** What a command prints, by its argv[0]; one not listed here exits 1. */
  tails: Record<string, string>
}

/** The language a test runs in; without either, the mod is on `auto`. */
const ZH = { options: { language: 'zh' } }
const EN = { options: { language: 'en' } }

const AT5 = '2026-10-06T13:20:00.000Z'
const AT7 = '2026-10-06T19:00:00.000Z'

function world(on: On, init: Partial<World> & { store?: Record<string, unknown> } = {}): World {
  const w: World = {
    readings: [
      { kind: 'five_hour', percentUsed: 10, resetsAt: AT5 },
      { kind: 'seven_day', percentUsed: 57, resetsAt: AT7 },
    ],
    sid: 'sess-a',
    env: {},
    toasts: [],
    status: [],
    requests: 0,
    files: {},
    registered: [],
    clock: undefined as unknown as ReturnType<typeof mock.clock>,
    fetches: [],
    usageBody: undefined,
    authorized: true,
    runs: [],
    tails: {},
    ...init,
  }
  mock.store(on, init.store ?? {})
  w.clock = mock.clock(on, { now: 1_000_000 })
  on('session.authorize', () => ({ value: w.authorized ? { handle: 'h-1', kind: 'bearer' } : null }))
  on('http.fetch', ($, e) => {
    w.fetches.push({ url: e.url, auth: e.init?.auth })
    return w.usageBody === undefined
      ? { value: { status: 500, ok: false, headers: {}, text: 'boom' } }
      : { value: { status: 200, ok: true, headers: {}, text: w.usageBody } }
  })
  on('session.id', () => ({ value: w.sid }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: w.readings } }))
  on('env.get', ($, e) => ({ value: w.env[e.name] }))
  on('env.set', ($, e) => ((w.env[e.name] = e.value), { value: {} }))
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.status', ($, e) => (w.status.push(e.text), { value: undefined }))
  on('command.register', ($, e) => (w.registered.push(e), { value: { command: e.name } }))
  on('fs.read', ($, e) => {
    const hit = Object.keys(w.files).find(k => e.path.replace(/\\/g, '/').endsWith(k))
    return hit ? { value: w.files[hit]! } : { deny: `ENOENT ${e.path}` }
  })
  on('process.run', ($, e) => {
    w.runs.push([...e.argv])
    const stdout = w.tails[e.argv[0]!]
    return { value: { exitCode: stdout === undefined ? 1 : 0, stdout: stdout ?? '', stderr: stdout === undefined ? 'no' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('classic.SessionStart', () => ({}))
  on('turn.step', async function* ($, e) {
    w.requests++
    return { turnId: e.turnId, index: e.index, answer: 'model answer', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('agent.spawn', () => ({ model: 'haiku' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  return w
}

async function step($: any, index = 0) {
  const s = $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1 })
  let n = await s.next()
  while (!n.done) n = await s.next()
  return n.value
}

async function budget($: any, args: string): Promise<string> {
  const r = await $.command.run({ command: 'budget', args, origin: { kind: 'composer' }, presentation: { layout: 'main', columns: 120 } })
  return String(r.text ?? '')
}

const usageJson = (fiveHour: number, sevenDay = 57) =>
  JSON.stringify({
    five_hour: { utilization: fiveHour, resets_at: AT5 },
    seven_day: { utilization: sevenDay, resets_at: AT7 },
    limits: [],
  })

describe('session-budget hooks', () => {
  test('a change prints nothing and confirms by toast; show prints two lines', ZH, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    expect(await budget($, '5h<=70')).toBe('')
    expect(w.toasts.at(-1)).toBe('[session-budget] 上限已更新：5h 10/70 [绝对 ≤70] 正常')
    const shown = await budget($, '')
    expect(shown.split('\n').length).toBe(2)
    expect(shown).toContain('5h 10/70 [绝对 ≤70] 正常')
    expect(shown).toContain('轮询 90 秒')
    expect(await budget($, 'help')).toContain('用法')
  })

  test('polling: the account figure, fetched with the session credential, stops the next request', ZH, async ($, on) => {
    const w = world(on, { usageBody: usageJson(75) })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    expect(w.fetches.length).toBe(0)
    await budget($, '5h<=70')
    await w.clock.advance(90_000)
    expect(w.fetches.length).toBe(1)
    expect(w.fetches[0]!.url).toContain('/api/oauth/usage')
    expect(w.fetches[0]!.auth).toBe('h-1')
    // Headers still say 10, the account says 75: the higher, fresher figure wins.
    const r = await step($)
    expect(r.answer).toContain('已触顶')
    expect(w.requests).toBe(0)
    expect(w.status.at(-1)).toContain('75/70')
    await w.clock.advance(90_000)
    expect(w.fetches.length).toBe(2)
  })

  test('polling: no timer without a budget, none after /budget off, interval set by /budget poll', ZH, async ($, on) => {
    const w = world(on, { usageBody: usageJson(20) })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await w.clock.advance(300_000)
    expect(w.fetches.length).toBe(0)
    expect(await budget($, 'poll 30')).toBe('')
    expect(w.toasts.at(-1)).toContain('30 秒')
    await budget($, '5h<=70')
    await w.clock.advance(60_000)
    expect(w.fetches.length).toBe(2)
    await budget($, 'off')
    await w.clock.advance(300_000)
    expect(w.fetches.length).toBe(2)
    expect(await budget($, 'poll 5')).toContain('15–3600')
  })

  test('polling: failures fall back to the headers and notify once after three', ZH, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await budget($, '5h<=70')
    await w.clock.advance(90_000 * 4)
    expect(w.fetches.length).toBe(4)
    expect(w.toasts.filter(t => t.includes('轮询连续失败')).length).toBe(1)
    const r = await step($)
    expect(r.answer).toBe('model answer')
  })

  test('in-flight estimate: a request expected to cross the ceiling is not sent', ZH, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await budget($, '5h<=70')
    // Each completed request moves the header reading by 2 points: cost ≈ 2/request.
    await step($, 0)
    w.readings = [{ kind: 'five_hour', percentUsed: 12, resetsAt: AT5 }, w.readings[1]!]
    await step($, 1)
    w.readings = [{ kind: 'five_hour', percentUsed: 14, resetsAt: AT5 }, w.readings[1]!]
    await step($, 2)
    expect(w.requests).toBe(3)
    // 69 + one request's 2 points ≥ 70: stopped before the ceiling, not after.
    w.readings = [{ kind: 'five_hour', percentUsed: 69, resetsAt: AT5 }, w.readings[1]!]
    const r = await step($, 3)
    expect(r.answer).toContain('在途请求预计再加')
    expect(w.requests).toBe(3)
    expect(await budget($, '')).toContain('单请求约')
  })

  test('in-flight estimate: with no cost samples yet, only the reading counts', ZH, async ($, on) => {
    const w = world(on, { readings: [{ kind: 'five_hour', percentUsed: 69, resetsAt: AT5 }] })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await budget($, '5h<=70')
    const r = await step($)
    expect(r.answer).toBe('model answer')
    expect(w.requests).toBe(1)
  })

  test('/budget is registered as immediate so it runs while a turn streams', ZH, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    const cmd = w.registered.find(c => c.name === 'budget')
    expect(cmd?.immediate).toBe(true)
  })

  test('no budget: requests go through untouched', ZH, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    const r = await step($)
    expect(r.answer).toBe('model answer')
    expect(w.requests).toBe(1)
  })

  test('over the absolute line: no request is sent, the turn ends with the notice', ZH, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await budget($, '5h<=10')
    const r = await step($)
    expect(w.requests).toBe(0)
    expect(r.answer).toContain('[session-budget]')
    expect(r.toolUses).toEqual([])
  })

  test('relative allowance counts from the reading at /budget time', ZH, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await budget($, '5h+5')
    await step($)
    expect(w.requests).toBe(1)
    w.readings = [{ kind: 'five_hour', percentUsed: 15, resetsAt: AT5 }]
    await step($, 1)
    expect(w.requests).toBe(1)
  })

  test('warn zone refuses new subagents, over zone drops plain prompts but not slash commands', ZH, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await budget($, '5h<=11')
    const spawn = await $.agent.spawn({ tool_use_id: 'x', prompt: 'p', description: 'd', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', fork: false, isTeammate: false, name: 'a' } as any)
    expect(spawn.deny).toContain('subagent')
    w.readings = [{ kind: 'five_hour', percentUsed: 11, resetsAt: AT5 }]
    const dropped = await $.prompt.submit({ text: 'keep going', wait: false } as any)
    expect((dropped as any).drop).toContain('[session-budget]')
    const cmd = await $.prompt.submit({ text: '/budget 5h<=50', wait: false } as any)
    expect((cmd as any).text).toBe('/budget 5h<=50')
  })

  test('the budget is exported for child processes and adopted from the env', ZH, async ($, on) => {
    const w = world(on, { env: { CC_SESSION_BUDGET: JSON.stringify({ five_hour: { abs: 10 } }) } })
    await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
    await step($)
    expect(w.requests).toBe(0)
    expect(JSON.parse(w.env.CC_SESSION_BUDGET!)).toEqual({ five_hour: { abs: 10 } })
  })

  test('/budget off stops limiting and clears the env', ZH, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await budget($, '5h<=10')
    expect(await budget($, 'off')).toBe('')
    expect(w.toasts.at(-1)).toContain('已关闭上限')
    expect(await budget($, '')).toContain('未设上限')
    expect(w.env.CC_SESSION_BUDGET).toBeUndefined()
    await step($)
    expect(w.requests).toBe(1)
  })

  test('a fork inherits the parent budget found by its copied uuids', ZH, async ($, on) => {
    const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
    const parent = { sessionId: 'sess-p', ring: [u(1), u(2)], updatedAt: 999_000, budget: { five_hour: { rel: { amount: 20, baseline: 4, resetsAt: AT5 } } } }
    const w = world(on, { sid: 'sess-f', store: { 'budget:sess-p': parent } })
    w.files['/t/fork.jsonl'] = `{"uuid":"${u(1)}"}\n{"uuid":"${u(2)}"}\n`
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'fork', transcript_path: '/t/fork.jsonl' } as any)
    expect(w.toasts.join('\n')).toContain('继承')
    expect(await budget($, '')).toContain('5h 10/24')
    w.readings = [{ kind: 'five_hour', percentUsed: 24, resetsAt: AT5 }]
    await step($)
    expect(w.requests).toBe(0)
  })
})

describe('session-budget language', () => {
  test('English: the same answers in the other language', EN, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    expect(w.registered[0]!.description).toBe("Cap this session's 5h / weekly usage (/budget help)")
    expect(await budget($, '5h<=70')).toBe('')
    expect(w.toasts.at(-1)).toBe('[session-budget] Cap updated: 5h 10/70 [absolute ≤70] ok')
    expect(await budget($, '')).toContain('polling every 90s')
    expect(await budget($, 'help')).toContain('Usage: /budget')
    expect(await budget($, 'nonsense')).toContain(`Can't read "nonsense"`)
    await budget($, '5h<=10')
    const r = await step($)
    expect(r.answer).toContain('This session reached its cap: 5h at 10% (cap 10%)')
    expect(w.requests).toBe(0)
  })

  test('auto: a zh locale gives Chinese', async ($, on) => {
    const w = world(on, { env: { LANG: 'zh_CN.UTF-8' } })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    expect(w.registered[0]!.description).toContain('用量上限')
    expect(await budget($, '')).toContain('未设上限')
  })

  test('auto: LC_ALL outranks LANG, and no locale at all (Windows) gives English', async ($, on) => {
    const w = world(on, { env: { LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' } })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    expect(await budget($, '')).toContain('No cap on this session')
    w.env = {}
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    expect(await budget($, '')).toContain('No cap on this session')
  })
})

describe('session-budget fork: a transcript too large to read whole', () => {
  const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
  const parent = { sessionId: 'sess-p', ring: [u(1), u(2)], updatedAt: 999_000, budget: { five_hour: { abs: 50 } } }
  const lastLines = `{"uuid":"${u(1)}"}\n{"uuid":"${u(2)}"}\n`
  const fork = ($: any) => $.classic.SessionStart({ source: 'fork', transcript_path: '/t/big.jsonl' } as any)

  test('off Windows, tail hands back the last lines and the fork inherits', ZH, async ($, on) => {
    const w = world(on, { sid: 'sess-f', store: { 'budget:sess-p': parent }, tails: { tail: lastLines } })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await fork($)
    expect(w.runs).toEqual([['tail', '-n', '400', '/t/big.jsonl']])
    expect(await budget($, '')).toContain('5h 10/50')
  })

  test('on Windows, PowerShell goes first and tail is the fallback when it fails', ZH, async ($, on) => {
    const w = world(on, { sid: 'sess-f', env: { OS: 'Windows_NT' }, store: { 'budget:sess-p': parent }, tails: { tail: lastLines } })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await fork($)
    expect(w.runs.map(argv => argv[0])).toEqual(['powershell', 'tail'])
    expect(await budget($, '')).toContain('5h 10/50')
  })

  test('neither tool ran: reported as a failed inheritance, not as a fork with no parent', EN, async ($, on) => {
    const w = world(on, { sid: 'sess-f', store: { 'budget:sess-p': parent } })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await fork($)
    expect(w.runs.map(argv => argv[0])).toEqual(['tail', 'powershell'])
    expect(w.toasts.join('\n')).toContain('fork inheritance failed')
    expect(w.status.at(-1)).toContain('ERROR')
    expect(await budget($, '')).toContain('No cap on this session')
  })

  test('no session holds a budget: the transcript is not read and nothing runs', ZH, async ($, on) => {
    const w = world(on, { sid: 'sess-f' })
    await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    await fork($)
    expect(w.runs.length).toBe(0)
    expect(w.toasts.length).toBe(0)
  })
})
