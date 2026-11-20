// Every string a person reads, in Chinese and in English. `en` is typed as `typeof zh`, so an
// entry missing from one table fails the type check. No `$` here, so it is unit-testable.

export type Lang = 'en' | 'zh'

const zh = {
  commandDescription: '离开时保住 prompt cache：/keepalive N、+N、off',
  usage: [
    '/keepalive            查看状态',
    '/keepalive N          开启：这次离开期间最多续 N 次（N=0 等于 off）',
    '/keepalive +N         在现有次数上再加 N 次',
    '/keepalive on         用默认次数开启',
    '/keepalive off        关闭',
  ].join('\n'),

  // /keepalive argument errors
  plusZero: '+0 没有意义',
  badArg: (arg: string) => `看不懂「${arg}」`,

  // the status line, after `keepalive used/max · `
  statusRunning: '等本轮结束',
  statusExhausted: '已用完',
  statusNoAnchor: '等第一轮结束',
  statusExpired: 'cache 已过期',
  statusPinging: '续命中',
  statusNext: (inTime: string) => `${inTime} 后续命`,

  // the one-line answer of a command that changed the arming; `rest` is `used/max · …`
  shortOff: 'keepalive 已关闭',
  shortOn: (rest: string) => `keepalive 已开启 ${rest}`,

  // the full answer of a bare /keepalive
  describeOff: (defaultMax: number, interval: number) =>
    `keepalive 关闭中。开启：/keepalive N（默认 N=${defaultMax}）。间隔 ${interval} 分钟，可在 /config 里改。`,
  describeOn: (used: number, max: number) => `keepalive 开启：本次离开期间已续 ${used}/${max} 次。`,
  describeRunning: '本轮对话还在跑，结束后开始计时。',
  describeExhausted: '次数已用完；/keepalive +N 可以追加。下一轮对话结束后计数归零。',
  describeNoAnchor: '还没有跑完过一轮对话，第一轮结束后开始计时。',
  describeExpired: (ago: string) => `上次请求已是 ${ago} 前，cache 已过期，这次不续；下一轮对话结束后重新开始。`,
  describePinging: '正在续命。',
  describeNext: (inTime: string) => `下一次续命在 ${inTime} 后。`,
  describeTiming: (interval: number, ttl: number) => `间隔 ${interval} 分钟，TTL 按 ${ttl} 分钟算。`,
  idleOff: 'idle compaction 已关闭：对话闲置时不会被压成摘要。',
  idleOn: 'idle compaction 开着：长对话闲置约一小时会被压成摘要。要保留完整对话，在 /config 里把它关掉。',

  // transcript lines; `head` is `keepalive used/max`
  pingWarm: (head: string, cached: string, total: string, percent: number) =>
    `${head}：已续命，cache 命中 ${cached}/${total} tokens（${percent}%）`,
  pingCold: (head: string, percent: number, total: string) => `${head}：cache 未命中（${percent}%），已重新写入 ${total} tokens`,
  coldOff: (ago: string) =>
    `keepalive：上次请求 ${ago} 前，cache 却已失效，已关闭；若 TTL 比间隔短，请在 /config 调小 intervalMinutes`,
  nothingToFork: 'keepalive：没有可续的对话（/clear 之后？），已关闭',
  pingFailed: (head: string, why: string, retryMinutes: number) => `${head}：续命失败（${why}），${retryMinutes} 分钟后重试`,
}

export type Messages = typeof zh

const en: Messages = {
  commandDescription: 'Keep the prompt cache warm while away: /keepalive N, +N, off',
  usage: [
    '/keepalive            show the state',
    '/keepalive N          arm: at most N pings during this absence (N=0 is off)',
    '/keepalive +N         raise the cap by N',
    '/keepalive on         arm with the default cap',
    '/keepalive off        disarm',
  ].join('\n'),

  plusZero: '+0 does nothing',
  badArg: arg => `Can't read "${arg}"`,

  statusRunning: 'waiting for this turn',
  statusExhausted: 'used up',
  statusNoAnchor: 'waiting for the first turn',
  statusExpired: 'cache expired',
  statusPinging: 'pinging',
  statusNext: inTime => `next ping in ${inTime}`,

  shortOff: 'keepalive off',
  shortOn: rest => `keepalive on ${rest}`,

  describeOff: (defaultMax, interval) =>
    `keepalive is off. Arm it with /keepalive N (default N=${defaultMax}). Interval ${interval} min, changed in /config.`,
  describeOn: (used, max) => `keepalive is on: ${used}/${max} pings used during this absence.`,
  describeRunning: 'A turn is still running; the timer starts when it ends.',
  describeExhausted: 'All pings are used; /keepalive +N adds more. The count resets when the next turn ends.',
  describeNoAnchor: 'No turn has finished yet; the timer starts when the first one ends.',
  describeExpired: ago =>
    `The last request was ${ago} ago and the cache has expired, so there is no ping this time; it starts again when the next turn ends.`,
  describePinging: 'Pinging now.',
  describeNext: inTime => `Next ping in ${inTime}.`,
  describeTiming: (interval, ttl) => `Interval ${interval} min, TTL taken as ${ttl} min.`,
  idleOff: 'Idle compaction is off: an idle conversation is not replaced by a summary.',
  idleOn:
    'Idle compaction is on: a long conversation left idle for about an hour is replaced by a summary. To keep the full conversation, turn it off in /config.',

  pingWarm: (head, cached, total, percent) => `${head}: cache kept warm, ${cached}/${total} tokens read from cache (${percent}%)`,
  pingCold: (head, percent, total) => `${head}: cache miss (${percent}%), ${total} tokens written again`,
  coldOff: ago =>
    `keepalive: the last request was ${ago} ago and the cache was already gone, so keepalive is off; if the TTL is shorter than the interval, lower intervalMinutes in /config`,
  nothingToFork: 'keepalive: no conversation to keep warm (after /clear?), so it is off',
  pingFailed: (head, why, retryMinutes) => `${head}: ping failed (${why}), retrying in ${retryMinutes} min`,
}

export function messages(lang: Lang): Messages {
  return lang === 'zh' ? zh : en
}

/** The `language` option when it names a language; undefined for `auto` or anything else. */
export function fixedLang(option: unknown): Lang | undefined {
  return option === 'en' || option === 'zh' ? option : undefined
}

/**
 * The language of a POSIX locale: the first of the given values that is set decides (pass them
 * as LC_ALL, LC_MESSAGES, LANG). `zh…` is Chinese; anything else, or none set as on Windows,
 * is English.
 */
export function langOfLocale(values: readonly (string | undefined)[]): Lang {
  const first = values.find(v => v !== undefined && v !== '')
  return first !== undefined && /^zh/i.test(first) ? 'zh' : 'en'
}
