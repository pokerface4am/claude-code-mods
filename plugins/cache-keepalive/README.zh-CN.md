# cache-keepalive

[English](README.md)

你离开键盘的时候，替你保住 Claude Code session 的 prompt cache，回来之后不用把整段对话重新写进 cache。

## 问题

Claude Code 会把到目前为止的对话缓存起来，之后每一轮都是读这份 cache，而不是把整段对话重新算一遍钱。用订阅、且在套餐自带额度之内时，主对话的 cache 在最后一次请求之后能活一小时，每次有请求读到它，这一小时就重新开始算（[Claude Code 文档](https://code.claude.com/docs/en/prompt-caching)）。

离开超过一小时，cache 就没了。你回来发的下一条消息，哪怕只有一句话，也要把整段对话重新写进 cache。按 API 标价，一小时 cache 的写入是基础输入价的 2 倍，读取是 0.025 到 0.1 倍，所以这一条消息的花费，相当于在同一段对话上正常聊 20 到 80 轮。

Claude Code 自带一个办法，叫 idle compaction，默认开着：20 万 token 以上的对话闲置约一小时，会被换成一份摘要。这样回来确实便宜，但你回来面对的是摘要。不到 20 万 token 的对话它不管，回来照样全量写一遍。

这个 mod 是第三种办法：对话原样保留，只在 cache 快过期的时候去读它一次。

## 它做什么

用 `/keepalive N` 开启之后，mod 会等到距离 session 最后一次请求过去 50 分钟，然后把那次请求原样分叉出一个极小的、不带工具的请求（`$.model.fork`），提示词只有一句「回一个句号」。这个请求读到了 cache，cache 的一小时就重新开始算。每次离开期间最多重复 N 次，所以不可能无限续下去。

## 安装

在终端 session 的提示符里：

```
/plugin install cache-keepalive --marketplace pokerface4am/claude-code-mods
```

或者在 shell 里：

```
claude plugin install cache-keepalive --marketplace pokerface4am/claude-code-mods
```

按 `y` 添加市场，选作用域，然后在设置界面把语言选成 `zh`（Windows 上 `auto` 会落到英文）。如果是开着 session 时从 shell 装的，在那个 session 里跑一次 `/reload-plugins`。

需要终端版 Claude Code 2.1.287 或更新。想确认本机能不能加载 mod：在任意一个没有 mod 的目录里跑 `claude plugin test`，输出 `no hooks module to load` 就是可以。

## 用法

```
/keepalive          查看状态
/keepalive 3        开启：这次离开期间最多续 3 次
/keepalive +2       在现有次数上再加 2 次（没开的时候等于以 2 次开启）
/keepalive on       用设置里的默认次数开启
/keepalive off      关闭
```

每个新 session 默认是关的，要你自己开。只要有一轮真正的对话跑完（你回来说了话，或者后台任务唤醒了 session），计数就归零。`/keepalive N` 是设上限、保留已用次数，`+N` 是「再加 N 次」。命令立即执行，回答中途也能输入，所以可以在长任务还没跑完的时候先开好再走开。

按默认设置，N 次能覆盖最长 `N × 50 + 60` 分钟的离开：3 次是三个半小时。

状态栏显示 `keepalive 1/3 · 42m 后续命`。每次续命会在对话记录里留一行暗色的字，写着 cache 命中了多少 token，供你回来时看。屏幕上只保留最新一次 `/keepalive` 的输出，旧的会折叠掉，连着开几次也只留一行。

## 续一次多少钱，丢一次多少钱

以模型基础输入价的倍数计，数据来自 Anthropic 的[价格页](https://platform.claude.com/docs/en/about-claude/pricing)：

| 模型 | 续一次（读 cache） | 丢一次（写一小时 cache） | 多少次续命抵一次丢失 |
|---|---|---|---|
| Claude Fable 5.2 | 0.025 倍 | 2 倍 | 79 |
| Claude Opus 5.5、Claude Sonnet 5.5 | 0.05 倍 | 2 倍 | 39 |
| cache 读取为标准价的模型 | 0.1 倍 | 2 倍 | 19 |

最后一列的算法是 `(2 − 读取倍率) ÷ 读取倍率`：续命的话，现在付一次读取，回来时再付一次读取，换掉那一次写入。每次续命另外还有几个输出 token。

这些是 API 标价。订阅不是按 token 计费的，cache 的读和写怎么折算进套餐的用量窗口，Anthropic 没有公开，所以这张表说明的是省的方向，不是对你额度的承诺。

## 我自己量到的

来自我自己大约三周半的对话记录，用脚本统计：

- 续命发出并得到回应的有四十多次，只有一次发现 cache 已经冷了。其中二十多次是连续的第二、第三、第四次续命，说明续一次确实能让那一小时重新开始。
- 开着 keepalive、离开超过一小时、并且在续命还覆盖得到的时候回来，有十来次，每一次 cache 都是热的。
- 没开的时候，离开超过一小时再回来有五十多次，每一次 cache 都是冷的，一共重写了大约 1600 万 token。按 API 标价接近 200 美元。
- 有几次我离开的时间超过了开的次数能覆盖的范围，回来时 cache 是冷的。这是次数上限在起作用。

## 什么时候有用，什么时候没用

**它依赖一小时的 cache。** Claude Code 只有在「订阅、且在套餐自带额度内」时才默认申请一小时的 TTL。用 API key 或云厂商，或者超出套餐限额、开始走用量点数之后，主对话的 cache 只有五分钟。这时按 mod 的默认设置，第一次续命就会发现 cache 已经没了，它会告诉你并且自己关掉。用 API key 或云厂商的话，先把 Claude Code 的 `promptCacheTtl` 设置改成 `1h`。

**idle compaction 和这个 mod 是二选一。** idle compaction 默认开着，按文档的说法，它的计时是从 session 最后一次请求算起的；mod 发的请求算不算，文档没写。我自己是把 idle compaction 关掉用的（`/config` 里的 `Idle compaction` 一行，或者 settings.json 里写 `"idleCompaction": false`），两者同时开的情况我没有测过。如果压缩真的发生了，mod 会察觉，不再去续旧的对话，等你的下一轮。想保留完整对话，就把 idle compaction 关掉；能接受摘要的话，大对话用不着这个 mod。

**它管几个小时，不管过夜。** 续一次要把整个上下文读一遍。60 万 token 的对话每次就是读 60 万 token，再便宜也是钱；而且如果你没在最后一次续命后的一小时内回来，前面的就白续了。

**电脑得醒着。** 计时器跑在 Claude Code 的进程里。

## 几道保险

- 每个 session 默认关闭，每次离开最多续 N 次。
- 续命时发现 cache 是冷的（从 cache 读到的不足一半），会自动关闭：cache 在续命之前就没了，继续续等于每次都把整个上下文重写一遍。
- 续命遇到 API 错误，5 分钟后重试，重试也算一次。
- 超过 TTL 就不续了：这时候写 cache，和等你回来发消息时写，花的是一样的钱。
- 对话被压缩之后，mod 等下一轮对话，不去续旧的对话。

## 这个 mod 会碰什么

mod 是以你的权限运行的代码，所以这里把它碰的东西全部列出来。`claude plugin validate` 会从源码里打印出同一份清单。

- **它会在你离开时发模型请求。** 这就是它的全部功能，每一次都消耗你的用量：整个上下文按 cache 读取价，加几个输出 token。你不在那个 session 里开启，它就不发；开了也最多 N 次。
- **它自己不发任何网络请求**，不读写文件，不起进程。
- **环境变量。** 读 `LANG`、`LC_ALL`、`LC_MESSAGES`，用来选语言。不写任何变量。
- **session 状态。** 三个值：开启情况（上限和已用次数）、cache 上次被读到的时间、上一次 `/keepalive` 输出的文字。

## 设置

在 `/config` 里，或安装时的设置界面：

- `language`（`auto`）：`auto`、`en` 或 `zh`。`auto` 跟随 `LC_ALL` / `LC_MESSAGES` / `LANG`，识别不出时用英文，Windows 上通常就是这个结果。
- `intervalMinutes`（50）：最后一次请求之后多少分钟续一次。要比 TTL 短。
- `cacheTtlMinutes`（60）：超过这个时间就不续了。
- `defaultMax`（3）：`/keepalive on` 用的次数。
- `retryMinutes`（5）：续命失败后等多久重试。

## 开发

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # 不安装、直接试跑
```

在 Windows 上开发和使用；这个 mod 没有和平台相关的代码。非官方项目，与 Anthropic 无关。MIT 许可证。
