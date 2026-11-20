// Every string a person reads, in Chinese and in English. `en` is typed as `typeof zh`, so an
// entry missing from one table fails the type check. No `$` here, so it is unit-testable.

export type Lang = 'en' | 'zh'

const zh = {
  commandDescription: '本 session 的 5h / 周用量上限（/budget help）',
  usage:
    '用法：/budget 5h<=70 week+5（<= 绝对线，+ 相对额度，可组合）｜/budget off [5h|week]｜/budget poll 90|off（账号用量轮询间隔，秒）｜/budget 查看',

  // /budget argument errors
  pollArg: (min: number) => `poll 要跟秒数（${min}–3600）或 off，如 /budget poll 90`,
  unknownWindow: (given: string) => `不认识的窗口：${given}（用 5h 或 week）`,
  badToken: (token: string) => `看不懂「${token}」。格式：5h<=70（绝对线）或 5h+20（相对额度），窗口 5h / week`,
  badValue: (token: string) => `「${token}」的数值要在 0–100 之间`,

  // the stop and the warning
  listSep: '，',
  hit: (label: string, used: string, pending: string | undefined, ceiling: string) =>
    `${label} 已用 ${used}%${pending === undefined ? '' : `，在途请求预计再加 ${pending}`}（上限 ${ceiling}%）`,
  blocked: (hits: string, win: string) =>
    `[session-budget] 本 session 已触顶：${hits}。已停止发送模型请求；用 /budget 查看，/budget ${win}<=N 调高或 /budget off 关闭后继续。`,
  nearCeiling: (near: string) => `[session-budget] 接近上限（${near}），不再派新的 subagent。`,

  // what /budget prints and confirms
  abs: (n: number) => `绝对 ≤${n}`,
  rel: (amount: number, baseline: string | undefined) =>
    `相对 +${amount}${baseline === undefined ? '（等首个读数定基线）' : `（基线 ${baseline}）`}`,
  level: { ok: '正常', warn: '接近上限', over: '已触顶' },
  polling: (seconds: number) => `轮询 ${seconds} 秒`,
  notPolling: '不轮询',
  noBudget: (poll: string) => `本 session 未设上限（${poll}）。/budget help 看用法`,
  cost: (points: string, inFlight: number) => ` · 单请求约 ${points} 点（5h） · 在途 ${inFlight}`,
  helpHint: ' · /budget help 看用法',
  pollSet: (seconds: number) => `[session-budget] 轮询间隔改为 ${seconds} 秒`,
  pollOff: '[session-budget] 已关闭轮询',
  budgetOff: '[session-budget] 已关闭上限',
  budgetSet: (line: string) => `[session-budget] 上限已更新：${line}`,

  // faults and polling
  faultStatus: 'budget: ERROR（保护失效，见提示）',
  faultToast: (error: string) => `[session-budget] 出错，暂时放行：${error}`,
  pollCrashed: (error: string) => `[session-budget] 轮询出错：${error}`,
  noCredential: '没有第一方登录凭证（API key 或网关登录不支持轮询）',
  badUsageBody: '返回格式不认识',
  pollFailing: (times: number, error: string) =>
    `[session-budget] 账号用量轮询连续失败 ${times} 次，暂用本 session 的响应读数：${error}`,

  // /fork
  forkNoParent: '[session-budget] fork：没找到设了上限的父 session，本 session 不限；需要的话用 /budget 设置',
  forkInherited: (status: string) => `[session-budget] 已从父 session 继承上限。${status}`,
  forkFailed: 'fork 继承失败',
}

export type Messages = typeof zh

const en: Messages = {
  commandDescription: "Cap this session's 5h / weekly usage (/budget help)",
  usage:
    'Usage: /budget 5h<=70 week+5 (<= absolute line, + relative allowance, combinable) | /budget off [5h|week] | /budget poll 90|off (account usage polling interval, seconds) | /budget to show',

  pollArg: min => `poll takes seconds (${min}–3600) or off, e.g. /budget poll 90`,
  unknownWindow: given => `Unknown window: ${given} (use 5h or week)`,
  badToken: token => `Can't read "${token}". Write 5h<=70 (absolute line) or 5h+20 (relative allowance); the windows are 5h and week`,
  badValue: token => `The value in "${token}" must be between 0 and 100`,

  listSep: ', ',
  hit: (label, used, pending, ceiling) =>
    `${label} at ${used}%${pending === undefined ? '' : `, requests in flight expected to add ${pending}`} (cap ${ceiling}%)`,
  blocked: (hits, win) =>
    `[session-budget] This session reached its cap: ${hits}. No more model requests are sent. Run /budget to see it; raise it with /budget ${win}<=N or turn it off with /budget off to go on.`,
  nearCeiling: near => `[session-budget] Close to the cap (${near}): no new subagents.`,

  abs: n => `absolute ≤${n}`,
  rel: (amount, baseline) =>
    `relative +${amount}${baseline === undefined ? ' (baseline set by the first reading)' : ` (baseline ${baseline})`}`,
  level: { ok: 'ok', warn: 'near cap', over: 'at cap' },
  polling: seconds => `polling every ${seconds}s`,
  notPolling: 'not polling',
  noBudget: poll => `No cap on this session (${poll}). /budget help for usage`,
  cost: (points, inFlight) => ` · about ${points} points per request (5h) · ${inFlight} in flight`,
  helpHint: ' · /budget help for usage',
  pollSet: seconds => `[session-budget] Polling every ${seconds}s`,
  pollOff: '[session-budget] Polling off',
  budgetOff: '[session-budget] Cap removed',
  budgetSet: line => `[session-budget] Cap updated: ${line}`,

  faultStatus: 'budget: ERROR (not protecting, see the notice)',
  faultToast: error => `[session-budget] Error, letting requests through for now: ${error}`,
  pollCrashed: error => `[session-budget] Polling error: ${error}`,
  noCredential: 'no first-party login credential (an API key or gateway login cannot be polled)',
  badUsageBody: 'unrecognized response format',
  pollFailing: (times, error) =>
    `[session-budget] Account usage polling failed ${times} times in a row; using this session's own response readings for now: ${error}`,

  forkNoParent: '[session-budget] fork: no parent session with a cap was found, so this session has none; set one with /budget if you need it',
  forkInherited: status => `[session-budget] Cap inherited from the parent session. ${status}`,
  forkFailed: 'fork inheritance failed',
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
