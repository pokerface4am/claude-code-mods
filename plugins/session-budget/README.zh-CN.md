# session-budget

[English](README.md)

给**单个 Claude Code session** 设账号 5 小时 / 周用量的上限。触顶后软停：主线程和 subagent 都不再发模型请求，session 不关，调高上限后可以继续。

Claude Code 的用量限制是账号级的，不分 session。一次长时间的自动运行、一次 subagent 扇出，都可能在你回头看屏幕之前把整个窗口用完。这个 mod 给每个 session 单独划一条线。

## 安装

在终端 session 的提示符里：

```
/plugin install session-budget --marketplace pokerface4am/claude-code-mods
```

或者在 shell 里：

```
claude plugin install session-budget --marketplace pokerface4am/claude-code-mods
```

按 `y` 添加市场，选作用域，然后在设置界面把语言选成 `zh`（Windows 上 `auto` 会落到英文）。如果是开着 session 时从 shell 装的，在那个 session 里跑一次 `/reload-plugins`。

需要终端版 Claude Code 2.1.287 或更新。想确认本机能不能加载 mod：在任意一个没有 mod 的目录里跑 `claude plugin test`，输出 `no hooks module to load` 就是可以。

## 用法

```
/budget                 查看本 session 的上限和当前读数
/budget 5h<=70          绝对线：账号 5h 用量到 70% 就停
/budget 5h+20           相对额度：从现在的读数起，本 session 最多再用 20 个百分点
/budget 5h<=70 week+5   可组合；同一窗口两种都设时取更低的那条
/budget off [5h|week]   关闭全部或某个窗口
/budget poll 90         账号用量轮询间隔（秒，15–3600；默认 90；poll off 关闭，所有 session 共用）
```

`/budget` 在 Claude 回答中途也能直接输入，立即生效，不用先中断：新上限从下一个模型请求起生效。改设置的命令不在对话记录里留输出，只弹一条确认提示并更新状态栏。`/budget` 不带参数打印两行当前状态，`/budget help` 打印用法。

窗口名是 `5h`，以及 `week` / `wk` / `7d`。状态栏显示 `budget 5h 6/70 · week 57/60`，⚠ 表示接近上限，⛔ 表示已触顶。`5h 68.2+1.5/70` 里的 `+1.5` 是在途请求预计还要加的点数。

## 各种情况下的行为

| 情况 | 动作 |
|---|---|
| 离上限 2 个百分点以内 | 拒绝派新的 subagent，提示一次 |
| 到达上限 | 每个模型请求发出前检查，不再发送；新的普通 prompt 会被拦下（以 `/` 开头的命令照常执行） |
| 5h / 周窗口重置 | 相对额度按重置后的读数重新算 |
| Bash 里启动的 `claude -p` 或其他 `claude` | 通过环境变量 `CC_SESSION_BUDGET` 继承同一份上限，自己检查 |
| `/fork` | 新 session 继承父 session 的剩余额度（同一条线），之后两边独立 |
| `/clear` | 上限跟到新的对话里 |
| resume | 从 mod 的存储里恢复上限 |

## 读数从哪来

Claude Code 给 mod 的读数是**本 session 上一次 API 响应**里的百分比，别的 session 在用额度时它不动。所以 mod 另外做了两件事：

1. **轮询账号用量。** 设了上限时，每 90 秒（`/budget poll N` 可调）请求一次 `/usage` 背后的接口，和响应里的读数合并：同一窗口内取较高的，因为用量只增不减、两边取整方式不同；窗口重置后取新的。连续失败 3 次提示一次，之后只用响应里的读数。
2. **预估在途请求。** 每次模型请求发出前，用最近 8 次完成的请求让 5h 读数涨了多少，算出单个请求的平均点数，乘以在途请求数（含即将发出的这个），加到读数上再和上限比。别的 session 的消耗会把这个预估抬高，所以结果是偏早停。`/budget` 会显示当前估的单请求点数和在途数。

## 这个 mod 会碰什么

mod 是以你的权限运行的代码，所以这里把它碰的东西全部列出来。`claude plugin validate` 会从源码里打印出同一份清单。

- **用你的登录态读你自己的用量。** 每次轮询，mod 向 Claude Code 要一个授权句柄（`$.session.authorize()`），用它对 `https://api.anthropic.com/api/oauth/usage` 发一次 GET。句柄是不透明的：凭证由 Claude Code 自己附上，而且只发给官方域名，token 不会到 mod 的代码里。这个接口就是 `/usage` 读的那个，不在公开文档里，可能会变；变了的话 mod 退回只用响应里的读数。`/budget poll off` 可以关掉轮询。用 API key 或网关登录时没有第一方凭证，不会轮询。
- **没有别的网络请求。** 不向我或任何第三方发送任何东西。
- **环境变量。** 读 `CC_SESSION_BUDGET`、`LANG`、`LC_ALL`、`LC_MESSAGES`、`OS`；写 `CC_SESSION_BUDGET`，子进程 `claude` 靠它继承上限。
- **mod 自己的存储。** 每个设了上限的 session 一条记录（上限，以及该 session 最近 64 条对话记录的 id，用来给 fork 找父 session），外加轮询间隔。8 天没动过的记录会被删掉。
- **只在 `/fork` 时读一个文件、最多起一个进程。** 有 session 设了上限时，fork 会读自己的对话记录文件来找父 session。文件超过 4 MiB 时，Windows 上运行一次 `powershell Get-Content -Tail 400`，其他系统运行一次 `tail -n 400`。

## 已知局限

- 读到的是**账号级**百分比，没有「单个 session 用了多少」这个数。所以相对额度会把同时在跑的其他 session 的消耗也算进来，会偏早停。绝对线没有这个问题。
- 仍可能略超上限：在途预估是估算；一个 session 还没有完成过请求时预估为 0；子进程的第一个请求发出时还没有读数。
- 触顶的那个响应里已经发起的工具调用仍会执行。工具本身不消耗额度；Agent 工具和子进程 `claude` 另有拦截。
- 只读 `five_hour` 和 `seven_day` 两个窗口。套餐里如果有针对某个模型的周额度，不在范围内。
- mod 自身出错时**放行**：状态栏显示 `budget: ERROR`，并弹提示告诉你保护失效。
- fork 靠对话记录里的行 id 找父 session。从同一个 session 连续 fork、中间没有新消息时，可能匹配到兄弟 session，但两者的上限相同，没有影响。
- 在 Windows 上开发和使用。macOS 和 Linux 上除了「大对话记录用 `tail` 读尾部」这一条路径，跑的是同一份代码；那条路径只有单元测试覆盖，没有在真机上验证过。

## 设置

`language`（`/config` 里，或安装时的设置界面）：`auto`、`en` 或 `zh`。`auto` 跟随 `LC_ALL` / `LC_MESSAGES` / `LANG`，识别不出时用英文，Windows 上通常就是这个结果。

## 开发

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # 不安装、直接试跑
```

非官方项目，与 Anthropic 无关。MIT 许可证。
