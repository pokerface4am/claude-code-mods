# session-budget

[中文说明](README.zh-CN.md)

Cap how much of your account's 5-hour and weekly usage **one Claude Code session** may use. At the cap the session soft-stops: no more model requests go out, from the main thread or from subagents. The session stays open, and raising the cap lets it go on.

Claude Code's usage limits belong to the account, not to a session. Nothing stops one long autonomous run, or one fan-out of subagents, from using the whole window before you look at the screen again. This mod gives each session its own line.

## Install

At the prompt of a terminal session:

```
/plugin install session-budget --marketplace pokerface4am/claude-code-mods
```

From a shell:

```
claude plugin install session-budget --marketplace pokerface4am/claude-code-mods
```

Answer `y` to add the marketplace, pick a scope, and choose a language on the settings screen. If you installed from a shell while a session was open, run `/reload-plugins` in that session.

Needs Claude Code 2.1.287 or later in the terminal. To check that mods can load on your machine, run `claude plugin test` in any folder that holds no mod: `no hooks module to load` means they can.

## Usage

```
/budget                 show this session's caps and the current readings
/budget 5h<=70          absolute line: stop when the account's 5h usage reaches 70%
/budget 5h+20           relative allowance: from the reading now, this session may use 20 more points
/budget 5h<=70 week+5   combinable; both kinds on one window in one command: the lower line wins
                        (a later command for a window replaces that window's line)
/budget off [5h|week]   remove every cap, or one window's
/budget poll 90         account usage polling interval in seconds (15–3600, default 90; `poll off` stops it; shared by all sessions)
```

`/budget` can be typed while Claude is still answering and takes effect at once, without interrupting: the new cap applies from the next model request. A command that changes something leaves nothing in the transcript; it confirms with one toast and updates the status line. A bare `/budget` prints two lines of state, and `/budget help` prints the usage.

Window names are `5h`, and `week` / `wk` / `7d`. The status line reads `budget 5h 6/70 · week 57/60`. ⚠ marks a window close to its cap and ⛔ one that reached it. In `5h 68.2+1.5/70`, the `+1.5` is what the requests in flight are expected to add.

## What happens when

| Situation | What the mod does |
|---|---|
| Within 2 points of the cap | Refuses new subagents and says so once |
| At the cap | Checks before every model request and sends none; a new plain prompt is dropped (anything starting with `/` still runs) |
| The 5h or weekly window resets | A relative allowance starts over from the reading after the reset |
| A `claude -p` or another `claude` started from Bash | Inherits the same cap through the `CC_SESSION_BUDGET` environment variable and checks for itself |
| `/fork` | The new session inherits the parent's remaining allowance (the same line); after that the two are independent |
| `/clear` | The cap follows into the new conversation |
| Resume | The cap comes back from the mod's store |

## Where the readings come from

Claude Code hands a mod the percentages from **this session's last API response**. They stand still while another session is using the account, so the mod does two more things:

1. **It polls the account's usage.** While a cap is set, every 90 seconds (`/budget poll N` changes it) it asks the endpoint behind `/usage` and merges the answer with the response figures: within one window the higher figure wins, since usage only grows and the two sources round differently; after a reset the newer window wins. Three failures in a row produce one notice, and the mod goes on with the response figures alone.
2. **It estimates the requests in flight.** Before each model request it takes how much the last 8 completed requests raised the 5h reading, multiplies that per-request figure by the number of requests in flight (the one about to go included), and adds it to the reading before comparing with the cap. Other sessions' use inflates that estimate, so it errs toward stopping early. `/budget` shows the current per-request figure and the number in flight.

## What this mod touches

A mod is code that runs with your permissions, so here is all of it. `claude plugin validate` prints the same list from the source.

- **Your login, to read your own usage.** For each poll the mod asks Claude Code for an authorization handle (`$.session.authorize()`) and spends it on one GET to `https://api.anthropic.com/api/oauth/usage`. The handle is opaque: Claude Code attaches the credential itself, only for a first-party host, and the token never reaches the mod's code. That endpoint is the one `/usage` reads; it is not a documented public API and may change, in which case the mod falls back to the response figures. `/budget poll off` stops the polling. With an API key or a gateway login there is no first-party credential, and nothing is polled.
- **No other network request.** Nothing is sent to me or to any third party.
- **Environment variables.** Reads `CC_SESSION_BUDGET`, `LANG`, `LC_ALL`, `LC_MESSAGES` and `OS`. Writes `CC_SESSION_BUDGET`, which is how a child `claude` process inherits the cap.
- **Its own store.** One record per capped session (the cap, and the ids of that session's 64 most recent transcript rows, used to find the parent of a fork), plus the polling interval. Records untouched for 8 days are deleted.
- **One file, one process, only on `/fork`.** When some session holds a cap, a fork reads its own transcript file to find its parent. If that file is over 4 MiB, the mod runs `powershell Get-Content -Tail 400` on Windows or `tail -n 400` elsewhere, once.

## Known limits

- The figures are **account-level** percentages; there is no "this session used X". A relative allowance therefore also counts what other sessions use meanwhile, and stops early. An absolute line has no such problem.
- The cap can still be passed by a little. The in-flight figure is an estimate; it is 0 until the session has completed its first request; and a child process's first request goes out before it has any reading.
- Tool calls already issued by the response that reached the cap still run. Tools use no quota by themselves; the Agent tool and child `claude` processes are stopped separately.
- Only the `five_hour` and `seven_day` windows are read. A model-specific weekly limit, where a plan has one, is not covered.
- When the mod itself fails it **lets requests through**: the status line shows `budget: ERROR` and a toast says the protection is off.
- A fork finds its parent by the row ids in its transcript. Two forks of one session with no new message between them may match each other instead, which changes nothing: their caps are the same.
- Developed and used on Windows. On macOS and Linux everything but the large-transcript `tail` path runs the same code; that path is covered by unit tests only.

## Settings

`language` (`/config`, or the screen shown at install): `auto`, `en` or `zh`. `auto` follows `LC_ALL` / `LC_MESSAGES` / `LANG` and falls back to English, which is what Windows gets.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # try it without installing
```

Unofficial; not affiliated with Anthropic. MIT license.
