# claude-code-mods

[English](README.md)

两个给 Claude Code 用的小 mod。各自堵住一种「session 在你没注意的时候把用量花掉」的情况。

| Mod | 命令 | 做什么 |
|---|---|---|
| [session-budget](plugins/session-budget/README.zh-CN.md) | `/budget` | 给单个 session 设账号 5 小时 / 周用量的上限，触顶后软停这个 session |
| [cache-keepalive](plugins/cache-keepalive/README.zh-CN.md) | `/keepalive` | 你离开时保住 prompt cache，回来不用把整段对话重新写进 cache |

## 为什么做这两个

10 月 3 日，我的一个 session 派出了层层嵌套的 subagent，十几个请求同时在跑，几分钟之内账号的 5 小时窗口就用光了。之后所有请求都是 429。Claude Code 的限额是账号级的，里面没有任何一处能说「这个 session 最多用这么多」。三天后我写出了 `/budget`。

`/keepalive` 来自另一个习惯：开着一个长 session 去吃午饭。prompt cache 能活一小时，过期之后的第一条消息要把整段对话重新写一遍，价格是输入价的 2 倍，而平时每一轮只是以 0.025 到 0.1 倍的价格读它。在过期之前读一次 cache，几乎不花钱，那一小时就重新开始算。

## 安装

在终端 session 的提示符里，一行装一个：

```
/plugin install session-budget --marketplace pokerface4am/claude-code-mods
/plugin install cache-keepalive --marketplace pokerface4am/claude-code-mods
```

或者在 shell 里：

```
claude plugin install session-budget --marketplace pokerface4am/claude-code-mods
claude plugin install cache-keepalive --marketplace pokerface4am/claude-code-mods
```

按 `y` 添加市场，选作用域，然后在设置界面把语言选成 `zh`。如果是开着 session 时从 shell 装的，在那个 session 里跑一次 `/reload-plugins`。

## 装之前

- **版本。** 终端版 Claude Code 2.1.287 或更新。两个 mod 都在 Windows 上的 2.1.327 测试过。
- **先确认本机能加载 mod。** 在任意一个没有 mod 的目录里跑 `claude plugin test`，输出 `no hooks module to load` 就是可以。装好之后，`/plugin` 页面的标签栏下面会有一行暗色的字，写着正在生效的 mod 的数量和名字。
- **公司账号。** 组织可以设置成只允许它自己管理的 mod。如果你的组织这么设了，这两个加载不了。
- **macOS 和 Linux。** 各平台跑的是同一份代码，只有 session-budget 里的一条路径例外（`/fork` 时读超大对话记录的尾部）。那条路径有单元测试，但没有在真的 Mac 或 Linux 机器上跑过。欢迎反馈。

## 它们会碰什么

mod 是以你的权限运行的代码。每个 mod 的 README 里都列出了它读什么、写什么、发什么，这里是简版：

- **session-budget** 会用你的登录态读你自己的用量。设了上限时，每 90 秒对 `https://api.anthropic.com/api/oauth/usage` 发一次 GET，这就是自带的 `/usage` 命令背后的接口。凭证由 Claude Code 自己附上，token 不会到 mod 的代码里。这个接口不在公开文档里。`/budget poll off` 可以关掉。除此之外它不发任何网络请求。
- **cache-keepalive** 会在你离开时发模型请求，这就是它的全部功能，每一次都消耗你的用量。你不在那个 session 里开启它就不发，开了也不会超过你给的次数。

`claude plugin validate <目录>` 会从源码里打印出一个 mod 注册的每个钩子和发起的每种调用。

## 语言

两个 mod 都有中文和英文界面。`language` 设置可以是 `auto`、`en` 或 `zh`。`auto` 跟随 `LC_ALL` / `LC_MESSAGES` / `LANG`，识别不出时用英文，Windows 上通常就是这个结果，所以中文用户请在安装时直接选 `zh`。

## 关于

非官方项目，与 Anthropic 无关。MIT 许可证。

我在 X 上写用 Claude Code 做东西的过程：[@4amPokerFace](https://x.com/4amPokerFace)。
