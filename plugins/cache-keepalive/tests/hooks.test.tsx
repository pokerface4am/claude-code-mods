import { describe, expect, mock, test } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'

const M = 60_000
const T0 = 1_000_000_000

type Fork = ModelForkResult

type World = {
  forks: { at: number; prompt: string }[]
  logs: string[]
  status: (string | undefined)[]
  registered: { name: string; description?: string; immediate?: true }[]
  clock: ReturnType<typeof mock.clock>
  answer: () => Fork
  env: Record<string, string | undefined>
}

/** The language a test runs in; without either, the mod is on `auto`. */
const ZH = { options: { language: 'zh' } }
const EN = { options: { language: 'en' } }

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const warm = (): Fork => ({ isAnswered: true, text: '.', usage: { ...ZERO, input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 100_000 } })
const cold = (): Fork => ({ isAnswered: true, text: '.', usage: { ...ZERO, output_tokens: 1, cache_creation_input_tokens: 90_000 } })
const failing = (): Fork => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' as const, usage: ZERO })

function world(on: On, env: Record<string, string | undefined> = {}): World {
  const w: World = { forks: [], logs: [], status: [], registered: [], clock: undefined as unknown as ReturnType<typeof mock.clock>, answer: warm, env }
  w.clock = mock.clock(on, { now: T0 })
  on('env.get', ($, e) => ({ value: w.env[e.name] }))
  on('command.register', ($, e) => (w.registered.push(e), { value: { command: e.name } }))
  on('ui.status', ($, e) => (w.status.push(e.text), { value: undefined }))
  on('ui.log', ($, e) => (w.logs.push(e.text), { value: undefined }))
  on('model.fork', ($, e) => (w.forks.push({ at: w.clock.now(), prompt: e.prompt }), { value: w.answer() }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '.', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return w
}

const advance = (w: World, ms: number) => w.clock.advance(ms)

async function keepalive($: any, args: string): Promise<string> {
  const r = await $.command.run({ command: 'keepalive', args, origin: { kind: 'composer' }, presentation: { layout: 'main', columns: 120 } })
  return String(r.text ?? '')
}

let turns = 0

/** A main-thread turn: one request at its start, the turn ending `lengthMs` later. */
async function turn($: any, w: World, lengthMs = 0, agentId?: string): Promise<void> {
  const turnId = `t${++turns}`
  await $.turn.start({ text: 'hi', turnId, ...(agentId ? { agentId } : {}) })
  const s = $.turn.step({ turnId, index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
  let n = await s.next()
  while (!n.done) n = await s.next()
  if (lengthMs > 0) await advance(w, lengthMs)
  await $.turn.complete({ answer: 'ok', durationMs: lengthMs, isAborted: false, turnId, reason: 'answer', ...(agentId ? { agentId } : {}) })
}

const start = ($: any) => $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1]

describe('cache-keepalive hooks', () => {
  test('off by default: a finished turn and an hour of silence ping nothing', ZH, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.registered.map(r => r.name)).toEqual(['keepalive'])
    expect(w.registered[0]!.immediate).toBe(true)
    await turn($, w)
    await advance(w, 70 * M)
    expect(w.forks.length).toBe(0)
    expect(last(w.status)).toBe(undefined)
  })

  test('/keepalive 2: pings at 50 and 100 minutes after the last request, then stops', ZH, async ($, on) => {
    const w = world(on)
    await start($)
    const armed = await keepalive($, '2')
    expect(armed).toBe('keepalive 已开启 0/2 · 等第一轮结束')
    await turn($, w)
    expect(last(w.status)).toBe('keepalive 0/2 · 50m 后续命')
    await advance(w, 49 * M)
    expect(w.forks.length).toBe(0)
    expect(last(w.status)).toBe('keepalive 0/2 · 1m 后续命')
    await advance(w, 1 * M)
    expect(w.forks.length).toBe(1)
    expect(w.forks[0]!.at).toBe(T0 + 50 * M)
    expect(w.forks[0]!.prompt).toContain('single period')
    expect(last(w.logs)).toBe('keepalive 1/2：已续命，cache 命中 100k/100k tokens（100%）')
    await advance(w, 50 * M)
    expect(w.forks.length).toBe(2)
    expect(w.forks[1]!.at).toBe(T0 + 100 * M)
    expect(last(w.status)).toBe('keepalive 2/2 · 已用完')
    await advance(w, 120 * M)
    expect(w.forks.length).toBe(2)
    expect(await keepalive($, '')).toContain('次数已用完')
  })

  test('the timer anchors on the request, not on the end of a long turn', ZH, async ($, on) => {
    const w = world(on)
    await start($)
    await keepalive($, '1')
    await turn($, w, 20 * M)
    expect(last(w.status)).toBe('keepalive 0/1 · 30m 后续命')
    await advance(w, 30 * M)
    expect(w.forks.length).toBe(1)
    expect(w.forks[0]!.at).toBe(T0 + 50 * M)
  })

  test('a real turn resets the count; a subagent turn does not', ZH, async ($, on) => {
    const w = world(on)
    await start($)
    await keepalive($, '1')
    await turn($, w)
    await advance(w, 50 * M)
    expect(w.forks.length).toBe(1)
    expect(last(w.status)).toBe('keepalive 1/1 · 已用完')
    await turn($, w, 0, 'agent-1')
    expect(last(w.status)).toBe('keepalive 1/1 · 已用完')
    await turn($, w)
    expect(last(w.status)).toBe('keepalive 0/1 · 50m 后续命')
    await advance(w, 50 * M)
    expect(w.forks.length).toBe(2)
  })

  test('+N raises the cap after it is spent; N sets it and keeps the count', ZH, async ($, on) => {
    const w = world(on)
    await start($)
    await keepalive($, '1')
    await turn($, w)
    await advance(w, 50 * M)
    expect(w.forks.length).toBe(1)
    expect(await keepalive($, '+1')).toBe('keepalive 已开启 1/2 · 50m 后续命')
    await advance(w, 50 * M)
    expect(w.forks.length).toBe(2)
    expect(await keepalive($, '5')).toBe('keepalive 已开启 2/5 · 50m 后续命')
    expect(await keepalive($, '2')).toBe('keepalive 已开启 2/2 · 已用完')
  })

  test('a turn starting cancels the pending ping; /keepalive off cancels it too', ZH, async ($, on) => {
    const w = world(on)
    await start($)
    await keepalive($, '3')
    await turn($, w)
    await advance(w, 40 * M)
    await $.turn.start({ text: 'back', turnId: 'long' })
    expect(last(w.status)).toBe('keepalive 0/3 · 等本轮结束')
    await advance(w, 30 * M)
    expect(w.forks.length).toBe(0)
    await $.turn.complete({ answer: 'ok', durationMs: 0, isAborted: false, turnId: 'long', reason: 'answer' })
    await advance(w, 10 * M)
    expect(await keepalive($, 'off')).toBe('keepalive 已关闭')
    expect(last(w.status)).toBe(undefined)
    await advance(w, 60 * M)
    expect(w.forks.length).toBe(0)
  })

  test('armed past the TTL it does not ping a cache that is already gone', ZH, async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, w)
    await advance(w, 65 * M)
    expect(await keepalive($, '2')).toBe('keepalive 已开启 0/2 · cache 已过期')
    await advance(w, 60 * M)
    expect(w.forks.length).toBe(0)
    await turn($, w)
    await advance(w, 50 * M)
    expect(w.forks.length).toBe(1)
  })

  test('a failed ping counts, retries after 5 minutes, and a success re-anchors', ZH, async ($, on) => {
    const w = world(on)
    w.answer = failing
    await start($)
    await keepalive($, '3')
    await turn($, w)
    await advance(w, 50 * M)
    expect(w.forks.length).toBe(1)
    expect(last(w.logs)).toContain('api-error 529')
    expect(last(w.status)).toBe('keepalive 1/3 · 5m 后续命')
    w.answer = warm
    await advance(w, 5 * M)
    expect(w.forks.length).toBe(2)
    expect(last(w.status)).toBe('keepalive 2/3 · 50m 后续命')
    await advance(w, 50 * M)
    expect(w.forks[2]!.at).toBe(T0 + 105 * M)
  })

  test('nothing to fork (after /clear) switches it off', ZH, async ($, on) => {
    const w = world(on)
    w.answer = () => ({ isAnswered: false, reason: 'nothing-to-fork' })
    await start($)
    await keepalive($, '3')
    await turn($, w)
    await advance(w, 50 * M)
    expect(w.forks.length).toBe(1)
    expect(last(w.status)).toBe(undefined)
    expect(await keepalive($, '')).toContain('关闭中')
  })

  test('a cold ping (cache already gone) switches it off instead of re-writing the cache each time', ZH, async ($, on) => {
    const w = world(on)
    w.answer = cold
    await start($)
    await keepalive($, '3')
    await turn($, w)
    await advance(w, 50 * M)
    expect(w.forks.length).toBe(1)
    expect(w.logs.some(l => l.includes('未命中'))).toBe(true)
    expect(last(w.logs)).toContain('已关闭')
    expect(last(w.status)).toBe(undefined)
    await advance(w, 100 * M)
    expect(w.forks.length).toBe(1)
  })

  test('only the latest /keepalive output row is drawn; older ones collapse; errors and other commands stay', ZH, async ($, on) => {
    const w = world(on)
    await start($)
    const t1 = await keepalive($, '3')
    const row = (id: string, text: string, command = 'keepalive', isErrored = false) =>
      $.ui.mount({ plugin: 'cache-keepalive', surface: 'terminal', component: 'CommandOutput', requestId: id, props: { command, args: '', text, isErrored } })
    const a = await row('a', `cache-keepalive: ${t1}`)
    expect((await a.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    const t2 = await keepalive($, '+1')
    expect(t2).not.toBe(t1)
    expect(await a.drawn()).toMatchObject({ type: 'Box', props: { display: 'none' } })
    const b = await row('b', `cache-keepalive: ${t2}`)
    expect((await b.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    const err = await row('err', 'boom', 'keepalive', true)
    expect((await err.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    const other = await row('o', 'keepalive 已开启 0/3 · 等第一轮结束', 'budget')
    expect((await other.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    for (const ui of [a, b, err, other]) await ui.unmount()
    void w
  })

  test('bad arguments print the usage', ZH, async ($, on) => {
    world(on)
    await start($)
    expect(await keepalive($, 'lots')).toContain('/keepalive +N')
  })
})

describe('cache-keepalive language', () => {
  test('English: arming, the status line, a ping and the exhausted state', EN, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.registered[0]!.description).toBe('Keep the prompt cache warm while away: /keepalive N, +N, off')
    expect(await keepalive($, '1')).toBe('keepalive on 0/1 · waiting for the first turn')
    await turn($, w)
    expect(last(w.status)).toBe('keepalive 0/1 · next ping in 50m')
    await advance(w, 50 * M)
    expect(w.forks.length).toBe(1)
    expect(last(w.logs)).toBe('keepalive 1/1: cache kept warm, 100k/100k tokens read from cache (100%)')
    expect(last(w.status)).toBe('keepalive 1/1 · used up')
    expect(await keepalive($, '')).toContain('All pings are used')
    expect(await keepalive($, 'lots')).toContain(`Can't read "lots"`)
    expect(await keepalive($, 'off')).toBe('keepalive off')
  })

  test('English: a cold ping and a failed ping say so', EN, async ($, on) => {
    const w = world(on)
    w.answer = failing
    await start($)
    await keepalive($, '3')
    await turn($, w)
    await advance(w, 50 * M)
    expect(last(w.logs)).toBe('keepalive 1/3: ping failed (api-error 529 overloaded), retrying in 5 min')
    w.answer = cold
    await advance(w, 5 * M)
    expect(w.logs.some(l => l.includes('cache miss (0%)'))).toBe(true)
    expect(last(w.logs)).toContain('the cache was already gone, so keepalive is off')
    expect(last(w.status)).toBe(undefined)
  })

  test('auto: a zh locale gives Chinese', async ($, on) => {
    const w = world(on, { LANG: 'zh_CN.UTF-8' })
    await start($)
    expect(w.registered[0]!.description).toContain('离开时')
    expect(await keepalive($, '2')).toBe('keepalive 已开启 0/2 · 等第一轮结束')
  })

  test('auto: no locale at all (Windows) gives English', async ($, on) => {
    world(on)
    await start($)
    expect(await keepalive($, '2')).toBe('keepalive on 0/2 · waiting for the first turn')
  })
})
