# Pocket Console (dsh-telegram-bridge)

English | [中文](README.zh.md)

<img src="icon.svg" width="72" alt="" align="right">

Command DeepSeek Harness Agents from your phone through a Telegram bot: send the Agent text, photos, files, and voice notes from your phone, watch replies arrive as they are written, answer tool approvals and the Agent's questions, follow long tasks for completion notices, and browse every chat in the Web UI, where any Session can be linked to Telegram.

The bot is another client of the Web host. It creates and prompts Sessions through `ctx.sessionController`, the same path the Web UI uses, so Telegram Sessions appear in the Web sidebar and Web Sessions can be taken over or followed. Sessions the bot creates go into the Web Workspace for their working directory (created on first use), listed with your other Sessions.

![Pocket Console overview](docs/images/panel-dashboard.png)

## Quick start

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token.
2. Install into a Web profile: **Plugins → Add plugin** with `github:heavenJiang/dsh-telegram-bridge`, or

   ```sh
   dsh plugin --profile web add github:heavenJiang/dsh-telegram-bridge
   ```

3. Open **Plugins → Installed → Pocket Console** (or **Plugin settings** in the sidebar's **Pocket Console** panel), fill in the **Bot token**, **Allowed users** (send `/whoami` to the bot for your id), and **Default working directory**, then **Save**. Changes apply immediately.

## In Telegram

| Command | Effect |
| --- | --- |
| text, photo, file, voice | Goes to the current Session; one is started in the default directory if needed |
| `/new [dir]` | New Session |
| `/cwd <dir>` | Working directory for this chat's new Sessions |
| `/sessions` | Recent Sessions, numbered |
| `/use <n\|sessionId>` | Switch to an existing Session (Web ones too) |
| `/watch [n\|sessionId]` | Follow a Session's completions and approvals; no argument lists them |
| `/unwatch <n\|sessionId\|all>` | Stop following |
| `/stop` | Stop current work |
| `/steer <text>` | Steer the running turn |
| `/queue`, `/cancel <n\|all>` | Show or drop queued messages |
| `/model [name]` | Show or switch the Session's model (buttons, fuzzy match; the Web default is untouched) |
| `/mode [mode]` | Show or switch the Session's permission mode |
| `/get <path>` | Fetch a file or list a directory inside the working directory (symlinks cannot escape it) |
| `/status` | Session, model, directory, and run state |
| `/whoami` | Your user and chat id (anyone) |
| other `/xxx` | Passed to the Agent verbatim |

- **Rendering**: Markdown replies become Telegram HTML (bold, italics, code, fenced code with language, links, headings, quotes, lists; tables as monospace blocks), split safely, with a plain-text fallback.
- **Streaming**: a draft message is edited every couple of seconds and then replaced by the formatted reply.
- **Tool activity**: all tool calls between two replies share one "🛠 Tool calls · N" message edited in place, so long runs do not flood the chat.
- **Turn summaries**: duration, tool calls, and changed files after long turns (configurable).
- **Approvals and questions**: tool approvals get **Allow once / Reject** buttons; the Agent's questions (ask_user_question) get option buttons, multi-select with **Done**, and any plain text while a question waits becomes the answer. Unanswered ones go to the Web UI after the timeout.
- **Media**: photos and files are staged through `ctx.fileUploads`; images (detected by their bytes) reach the model as images. Voice notes are converted with ffmpeg and transcribed by the Harness speech service; without it they go as files. Files the Agent presents are sent back.
- **Groups**: by default the bot answers only commands, @mentions, and replies to it. Authorize individual users or whole chats.
- **Security**: only allowed users (or members of allowed chats) can use the bot; strangers are told at most once an hour. The token lives in the Harness credentials store (`TELEGRAM_BOT_TOKEN`, or an environment variable of that name), never in the profile file or the browser; a legacy literal token migrates on the next save.

## In the Web UI

- **Pocket Console panel** (sidebar): chats with search and bot status; an overview with today's messages, active chats, approvals, blocks, and a 14-day chart; full threads with images, file cards, tool and approval cards, per-member filters in groups, and **Open Session**. **Plugin settings** and a **New** badge sit in the header.
- **Pocket Console tab in every Session**: linked chats, bind or follow another chat, send a message as the bot, and the Session's Telegram activity.
- **`/telegram` in the composer**: `bind`, `watch`, `unbind`, and `send` for the open Session; runs on the Host, never reaches the model.
- **Channel note**: Sessions bound to a chat get a short `ctx.systemPrompt.context()` note asking for phone-friendly replies.

![Chat thread](docs/images/panel-thread.png)

## Models

A `/model` choice for the Session > the plugin page's **Bot default model** for Sessions the bot creates > the Web default. Neither changes the Web default; choices for cold Sessions persist and apply when the Session next loads.

## Scheduled tasks

Chats listed in **Scheduled task chats** receive the replies and summaries of Harness scheduled tasks.

## Version and updates

The plugin page's **Version** section checks GitHub (the default branch's `package.json` version) or npm, and **Update to vX.Y.Z** reinstalls in place through the plugin manager. Bump `version` with every release.

## Configuration

See the full table in [README.zh.md](README.zh.md#配置项). Every user-facing field is live-editable; `pollTimeoutSec` and `stateFile` live in the profile's `cordis.patch.yml`. Set `HTTPS_PROXY` before launching `dsh` if Telegram is not directly reachable.

## Development

Type-checking and the Loader composition test use a built sibling checkout at `../deepseek-harness`.

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for npm publishing and [CHANGELOG.md](CHANGELOG.md) for changes.
