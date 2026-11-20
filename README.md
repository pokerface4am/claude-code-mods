# claude-code-mods

[中文说明](README.zh-CN.md)

Two small mods for Claude Code. Each one closes a way a session can spend your usage without you noticing.

| Mod | Command | What it does |
|---|---|---|
| [session-budget](plugins/session-budget/README.md) | `/budget` | Caps how much of the account's 5-hour and weekly usage one session may use, and soft-stops that session at the cap |
| [cache-keepalive](plugins/cache-keepalive/README.md) | `/keepalive` | Keeps the prompt cache warm while you are away, so coming back does not write the whole conversation to the cache again. Turns idle compaction off while installed |

## Why they exist

One of my sessions fanned out into nested subagents. A dozen or more requests ran at once, and within a few minutes the account's 5-hour window was used up. Every request after that came back 429. Claude Code's limits belong to the account, and nothing in it says "this session may use this much and no more". Three days later I had `/budget`.

`/keepalive` came from the opposite habit: leaving a long session open over lunch. The prompt cache lives for an hour, and the first message after it expires writes the whole conversation again, at 2x the input price where a normal turn reads it at 0.025x to 0.1x. Reading the cache once before it expires costs almost nothing and starts the hour over.

## Install

At the prompt of a terminal session, one mod per line:

```
/plugin install session-budget --marketplace pokerface4am/claude-code-mods
/plugin install cache-keepalive --marketplace pokerface4am/claude-code-mods
```

From a shell:

```
claude plugin install session-budget --marketplace pokerface4am/claude-code-mods
claude plugin install cache-keepalive --marketplace pokerface4am/claude-code-mods
```

Answer `y` to add the marketplace, pick a scope, and choose a language on the settings screen. If you installed from a shell while a session was open, run `/reload-plugins` in that session.

## Before you install

- **Version.** Claude Code 2.1.287 or later in the terminal. Both mods are tested on 2.1.327 on Windows.
- **Check that mods can load.** Run `claude plugin test` in any folder that holds no mod. `no hooks module to load` means they can. After installing, `/plugin` shows a dim line under its tabs with the count and names of the active mods.
- **Work accounts.** An organization can allow only the mods it manages. If yours does, these will not load.
- **macOS and Linux.** The code is the same on every platform except one path in session-budget (reading the tail of a very large transcript on `/fork`), which is covered by unit tests and has not been run on a real Mac or Linux machine. Reports are welcome.

## What they touch

A mod is code that runs with your permissions. Each README lists everything its mod reads, writes and sends; the short version:

- **session-budget** uses your login to read your own usage. While a cap is set it sends one GET to `https://api.anthropic.com/api/oauth/usage` every 90 seconds, the endpoint behind the built-in `/usage`. Claude Code attaches the credential itself and the token never reaches the mod's code. That endpoint is not a documented public API. `/budget poll off` stops it. It makes no other network request.
- **cache-keepalive** sends model requests while you are away, which is its whole job, and each one draws on your usage. It never does so unless you armed it in that session, and never more than the number of times you gave it. While installed it also makes Claude Code read its `idleCompaction` setting as off, because a summary is what it exists to avoid. No settings file is written, a value you set yourself wins, and the mod's `disableIdleCompaction` option keeps idle compaction on.

`claude plugin validate <folder>` prints, from the source, every hook a mod registers and every call it makes.

## Language

Both mods speak English and Chinese. The `language` setting is `auto`, `en` or `zh`; `auto` follows `LC_ALL` / `LC_MESSAGES` / `LANG` and falls back to English, which is what Windows gets.

## About

Unofficial; not affiliated with Anthropic. MIT license.

I post about building with Claude Code on X: [@4amPokerFace](https://x.com/4amPokerFace).
