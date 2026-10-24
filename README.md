# dsh-telegram-bridge

English | [中文](README.zh.md)

Drive DeepSeek Harness from a Telegram bot: prompt the Agent, stop work, switch working directories and Sessions, and answer tool approvals with inline buttons.

The bot is another client of the Web host. It creates and prompts Sessions through `ctx.sessionController`, the same path the Web UI uses, so Sessions started in Telegram show up in the Web sidebar and Web Sessions can be taken over with `/use`.

## Quick start

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token.
2. Install into a Web profile:

   ```sh
   dsh plugin --profile web add /path/to/dsh-telegram-bridge
   dsh web
   ```

   Or use **Plugins → Add plugin** in the Web sidebar with a local path or Git URL.
3. On **Plugins → Telegram Remote**, fill in the **Bot token**, **Allowed users** (send `/whoami` to the bot to get your id), and **Default working directory**.
4. **Save**. Changes apply live; no restart.

## Commands

| Command | Effect |
| --- | --- |
| plain text | Prompt the current Session; starts one in the default directory if none |
| `/new [dir]` | New Session |
| `/cwd <dir>` | Working directory for this chat's new Sessions |
| `/use <sessionId>` | Switch to an existing Session (Web ones too) |
| `/sessions` | Recent Sessions |
| `/stop` | Stop current work |
| `/steer <text>` | Steer the running turn |
| `/status` | Session, directory, and run state |
| `/whoami` | Your user and chat id (available to anyone) |
| other `/xxx` | Passed to the Agent verbatim (e.g. `/plan …`, skills) |

Assistant text, tool-call lines (optional), and failure/stop notices are posted back to the bound chat, with a typing indicator while the Agent runs.

## Approvals

With **Answer tool approvals in Telegram** on, an approval for a chat-bound Session is sent there with **Allow once / Reject** buttons and an argument preview. Only allowed users can press them. After the timeout the question goes to the Web UI unchanged.

## Configuration

See [README.zh.md](README.zh.md#配置项) for the full table. Every user-facing field is volatile and editable on the Plugins page; `pollTimeoutSec` and `stateFile` live in the profile's `cordis.patch.yml`. Set `HTTPS_PROXY` before launching `dsh` if Telegram is not directly reachable.

## Security

The bot lets an Agent run tools on this machine. Allow only your own user id; an empty list admits no one. Keep the default `workspace-write` preset with Telegram approvals unless you know what `danger-full-access` implies. The token is a `role('secret')` field and never reaches the browser.

## Development

Type-checking uses a built sibling checkout at `../deepseek-harness`.

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```
