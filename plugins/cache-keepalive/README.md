# cache-keepalive

[中文说明](README.zh-CN.md)

Keeps a Claude Code session's prompt cache warm while you are away from the keyboard, so that coming back does not write the whole conversation to the cache again.

## The problem

Claude Code caches the conversation so far, and every turn reads that cache instead of paying for the whole conversation again. On a Claude subscription, within your plan's included usage, the main conversation's cache lives for one hour after the last request, and each request that reads it starts the hour over ([Claude Code docs](https://code.claude.com/docs/en/prompt-caching)).

Stay away for longer than that and the cache is gone. Your next message, however short, writes the entire conversation to the cache again. At API list prices a one-hour cache write costs 2x the base input price and a cache read costs between 0.025x and 0.1x, so that one message costs as much as 20 to 80 ordinary turns on the same conversation.

Claude Code has a built-in answer, idle compaction, on by default: a conversation of 200K tokens or more that sits idle for about an hour is replaced by a summary. That makes coming back cheap, and what you come back to is a summary. Under 200K tokens nothing is done and you pay for the full write.

This mod is the third option. It keeps the conversation exactly as it is, by reading the cache once shortly before it would expire.

## What it does

Once you arm it with `/keepalive N`, the mod waits until 50 minutes have passed since the session's last request, then sends a tiny tool-less fork of that request (`$.model.fork`) whose whole prompt is "reply with a single period". The request reads the cache, which starts its hour over. It repeats at most N times per absence, so it can never renew forever.

While it is installed, the mod also turns Claude Code's idle compaction off, since a summary is the very thing it exists to avoid. That is a default you can change; see [Idle compaction](#idle-compaction) below.

## Install

At the prompt of a terminal session:

```
/plugin install cache-keepalive --marketplace pokerface4am/claude-code-mods
```

From a shell:

```
claude plugin install cache-keepalive --marketplace pokerface4am/claude-code-mods
```

Answer `y` to add the marketplace, pick a scope, and choose a language on the settings screen. If you installed from a shell while a session was open, run `/reload-plugins` in that session.

Needs Claude Code 2.1.287 or later in the terminal. To check that mods can load on your machine, run `claude plugin test` in any folder that holds no mod: `no hooks module to load` means they can.

## Usage

```
/keepalive          show the state
/keepalive 3        arm: at most 3 pings during this absence
/keepalive +2       raise the cap by 2 (also arms, with a cap of 2, when off)
/keepalive on       arm with the configured default
/keepalive off      disarm
```

It is off in every new session until you arm it. The count goes back to 0 whenever a real turn completes: you came back and said something, or a background task woke the session. `/keepalive N` sets the cap and keeps the count; `+N` means "N more". The command runs at once, even in the middle of a turn, so you can arm it while a long task is still running and walk away.

With the defaults, N pings cover an absence of up to `N × 50 + 60` minutes: 3 pings cover three and a half hours.

The status line shows `keepalive 1/3 · next ping in 42m`. Each ping leaves one dim line in the transcript saying how many tokens the cache served, for you to read when you are back. Only the latest `/keepalive` answer stays on screen; older ones collapse, so arming it several times leaves one line, not a stack.

## What it costs, and what a miss costs

In multiples of the model's base input price, from Anthropic's [pricing page](https://platform.claude.com/docs/en/about-claude/pricing):

| Model | One ping (cache read) | One miss (1-hour cache write) | Pings that cost as much as one miss |
|---|---|---|---|
| Claude Fable 5.2 | 0.025x | 2x | 79 |
| Claude Opus 5.5, Claude Sonnet 5.5 | 0.05x | 2x | 39 |
| Models with the standard cache read | 0.1x | 2x | 19 |

The last column is `(2 − read) ÷ read`: with a ping, you pay the read now and another read when you return, instead of the write. A ping also produces a few output tokens.

These are API list prices. A subscription is not billed per token, and Anthropic does not publish how cache reads and cache writes weigh against a plan's usage window, so take the table as the direction of the saving, not as a promise about your limits.

## What I measured

From my own transcripts over about three and a half weeks, counted by a script:

- Forty-odd pings went through. All but one found the cache warm, and twenty-odd of those were the second, third or fourth ping in a row, so a ping does start the hour over.
- With keepalive armed, I came back from a dozen or so breaks of over an hour while the pings still covered me. The cache was warm every time.
- Without it, I came back from fifty-odd breaks of over an hour. The cache was cold every time, and about 16 million tokens were written again. At API list prices that is close to $200.
- A handful of times I stayed away longer than the pings I had armed, and came back to a cold cache. That is the cap doing its job.

## When it helps and when it does not

**It depends on the one-hour cache.** Claude Code asks for the one-hour TTL by default only on a Claude subscription within the plan's included usage. With an API key or a cloud provider, or once you are over your plan's limit and drawing on usage credits, the main conversation gets five minutes instead. With the mod's defaults the first ping then finds the cache already gone, says so, and switches keep-alive off. If you use an API key or a cloud provider, set Claude Code's `promptCacheTtl` setting to `1h` first.

**It takes the place of idle compaction.** Installing the mod turns idle compaction off by default, in every session. The [Idle compaction](#idle-compaction) section says how, and how to keep it on. If a summary is fine for you, you do not need this mod for large conversations.

**It is for hours, not for the night.** A ping reads the whole context. On a 600K-token conversation each one reads 600K tokens, cheap as that is, and nothing is saved if you do not come back before the last ping's hour runs out.

**The computer has to stay awake.** The timer runs inside the Claude Code process.

## Idle compaction

Idle compaction and this mod answer the same problem in opposite ways: one replaces an idle conversation with a summary, the other keeps it as it is. Running both makes little sense, so **installing this mod turns idle compaction off by default.**

How it works:

- While the mod is installed and enabled, Claude Code reads its `idleCompaction` setting as `false`. This holds in every session, including the ones where you never arm `/keepalive`.
- Nothing is written to your settings files. The mod answers a `settings.read` hook, so the value changes only as Claude Code reads it. Disable or uninstall the mod and your own setting is back.
- A value you wrote yourself wins. If any settings file (yours, the project's, your organization's) sets `idleCompaction`, to `true` or to `false`, the mod leaves it alone.
- A bare `/keepalive` ends with a line saying whether idle compaction currently reads as on or off.

What it costs you: in a session where you do not arm `/keepalive`, a large idle conversation is no longer summarized, so coming back after more than an hour means the full cache write. That is what already happens to every conversation under 200K tokens.

To keep idle compaction on, do either of these:

- set the mod's `disableIdleCompaction` option to `false`, in `/config` or on the screen shown at install;
- write `"idleCompaction": true` in your `settings.json`.

One thing I have not done is leave a 200K-token session idle for an hour on a fresh install and watch the compaction not happen. The mod relies on Claude Code's documented behaviour that what a `settings.read` hook answers is what every reader of the settings gets, and its tests check that other readers see the rewritten value. My own machine has had `"idleCompaction": false` written in its settings all along.

## The safety valves

- Off by default in every session, and never more than N pings per absence.
- A ping that finds the cache cold (under half the prompt served from cache) switches keep-alive off: the cache was gone before the ping, and pinging on would write the whole context each time.
- A ping that fails with an API error is retried after 5 minutes, and the retry counts against the cap.
- Past the TTL the mod does not ping: writing the cache now costs the same as writing it on your next message.
- After a compaction the mod waits for the next turn instead of pinging the old conversation.

## What this mod touches

A mod is code that runs with your permissions, so here is all of it. `claude plugin validate` prints the same list from the source.

- **It sends model requests while you are away.** That is the whole point, and each one draws on your usage: the context at cache-read price plus a few output tokens. Never unless you armed it in that session, and at most N times.
- **It changes how one Claude Code setting reads.** `idleCompaction` reads as `false` while the mod is loaded, unless a settings file sets it or you turn the `disableIdleCompaction` option off. The value is rewritten as it is read and never written to disk. The mod also reads that setting, to tell you its state.
- **No network request of its own**, no file access, no process.
- **Environment variables.** Reads `LANG`, `LC_ALL` and `LC_MESSAGES`, to pick the language. Writes none.
- **Session state.** Three values: the arming (cap and count), when the cache was last touched, and the text of the last `/keepalive` answer.

## Settings

In `/config`, or on the screen shown at install:

- `language` (`auto`): `auto`, `en` or `zh`. `auto` follows `LC_ALL` / `LC_MESSAGES` / `LANG` and falls back to English, which is what Windows gets.
- `disableIdleCompaction` (`true`): read Claude Code's idle compaction as off while the mod is installed. See [Idle compaction](#idle-compaction).
- `intervalMinutes` (50): minutes after the last request before a ping. Keep it under the TTL.
- `cacheTtlMinutes` (60): past this age the mod does not ping.
- `defaultMax` (3): the cap `/keepalive on` uses.
- `retryMinutes` (5): wait before retrying a failed ping.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # try it without installing
```

Developed and used on Windows; this mod has no platform-specific code. Unofficial; not affiliated with Anthropic. MIT license.
