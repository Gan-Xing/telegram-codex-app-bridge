# telegram-codex-app-bridge

Use Telegram to control a local AI coding engine. The same codebase now supports two single-engine deployment modes:

- `codex`: bridges to `codex app-server`
- `gemini`: bridges to `gemini -p --output-format stream-json`

The runtime model is fixed:

- one bot = one engine
- one instance = one `.env.*` file
- one topic = one bot
- no runtime engine switching inside a topic

## What works

- Private chat or topic-aware group control for one allowed Telegram user
- Separate Codex and Gemini instances on the same host
- Sticky chat/topic binding, queued follow-ups, staged attachments, and restart-safe recovery
- Guided plan flow for Codex bots with confirm-or-revise gating
- Provider-aware `/help`, `/status`, `/settings`, and slash-command registration
- User-service deployment for Linux (`systemd --user`) and macOS (`launchd`)

## Engine differences

Both engines share the same Telegram shell, but the capabilities are intentionally not identical.

| Capability | Codex bot | Gemini bot |
| --- | --- | --- |
| Plain-text turns | Yes | Yes |
| Attachment staging | Yes | Yes |
| Queue and interrupt | Yes | Yes |
| `/threads` and `/open` | Yes | No |
| `/reveal` into local desktop host | Yes | No |
| Guided plan mode | Full | No |
| Approval controls | Full | No |
| Rate-limit snapshot in `/status` | Yes | No |
| `/reconnect` | Yes | No |

The bridge does not try to fake missing Gemini features. Unsupported commands are hidden from Gemini slash menus and rejected with a clear reply if called directly.

## Requirements

- Linux or macOS
- Node.js 24+
- One Telegram bot token per instance
- Your Telegram numeric user id
- For `codex` instances:
  - authenticated `codex` CLI
- For `gemini` instances:
  - authenticated `gemini` CLI

## Instance layout

Recommended naming:

- `linux144-codex`
- `linux144-gemini`

Recommended bot topology in one Telegram group:

- `Linux144bot` -> Codex topic
- `Glinux144bot` -> Gemini topic

Each topic should belong to exactly one bot. Do not share a topic across bots.

## Quick start

Install dependencies once:

```bash
npm install
```

Create one env file per instance:

```bash
cp .env.example .env.codex
cp .env.example .env.gemini
```

Build and run a foreground instance:

```bash
ENV_FILE=.env.codex npm run build
ENV_FILE=.env.codex npm run doctor
ENV_FILE=.env.codex npm run serve
```

For Gemini:

```bash
ENV_FILE=.env.gemini npm run build
ENV_FILE=.env.gemini npm run doctor
ENV_FILE=.env.gemini npm run serve
```

## Example env files

Codex bot:

```dotenv
BRIDGE_ENGINE=codex
BRIDGE_INSTANCE_ID=linux144-codex
TG_BOT_TOKEN=123456:codex-token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=-1001234567890
TG_ALLOWED_TOPIC_ID=101
DEFAULT_CWD=/home/ubuntu/dev
CODEX_CLI_BIN=/home/ubuntu/.local/bin/codex
CODEX_APP_AUTOLAUNCH=false
CODEX_APP_SYNC_ON_OPEN=true
CODEX_APP_SYNC_ON_TURN_COMPLETE=false
```

Gemini bot:

```dotenv
BRIDGE_ENGINE=gemini
BRIDGE_INSTANCE_ID=linux144-gemini
TG_BOT_TOKEN=123456:gemini-token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=-1001234567890
TG_ALLOWED_TOPIC_ID=202
DEFAULT_CWD=/home/ubuntu/dev
GEMINI_CLI_BIN=/home/ubuntu/.local/bin/gemini
GEMINI_DEFAULT_MODEL=gemini-2.5-pro
GEMINI_MODEL_ALLOWLIST=gemini-2.5-pro,gemini-2.5-flash
GEMINI_HEADLESS_TIMEOUT_MS=300000
```

## Service install

Linux user service:

```bash
ENV_FILE=.env.codex ./scripts/service/install.sh
ENV_FILE=.env.gemini ./scripts/service/install.sh
```

Useful service commands:

```bash
ENV_FILE=.env.codex ./scripts/service/status.sh
ENV_FILE=.env.codex ./scripts/service/logs.sh
ENV_FILE=.env.codex ./scripts/service/restart-safe.sh

ENV_FILE=.env.gemini ./scripts/service/status.sh
ENV_FILE=.env.gemini ./scripts/service/logs.sh
ENV_FILE=.env.gemini ./scripts/service/restart-safe.sh
```

`restart-safe.sh` is instance-aware. It builds, restarts only the targeted service, waits for `running=true` and `connected=true`, then sends a Telegram callback back to the latest active scope.

macOS install uses the same `ENV_FILE` pattern:

```bash
ENV_FILE=.env.codex ./scripts/service/install.sh
```

## Telegram setup

1. Create one bot token per engine with `@BotFather`.
2. Put each token into its own env file.
3. Set the same `TG_ALLOWED_USER_ID` for both instances if one operator controls both.
4. If you use a shared group:
   - set the same `TG_ALLOWED_CHAT_ID`
   - give each bot its own `TG_ALLOWED_TOPIC_ID`
5. Disable privacy mode and re-add the bot if natural-language group messages do not arrive.

## Commands

Shared commands:

- `/help`
- `/status`
- `/new`
- `/models`
- `/settings`
- `/queue`
- `/where`
- `/interrupt`
- `/restart`

Codex-only commands:

- `/threads`
- `/open`
- `/guide`
- `/permissions`
- `/mode`
- `/plan`
- `/reconnect`
- `/reveal`
- `/tier`
- `/fast`
- `/effort`

## Guided plan flow

Codex bots can run a Telegram-adapted guided plan loop:

1. Draft a plan without executing.
2. Render one live plan card as the plan evolves.
3. Ask you to `Continue`, `Revise`, or `Cancel`.
4. After confirmation, continue execution and request focused structured input when needed.
5. Recover pending plan/input/approval cards after restart.

Gemini bots do not expose this flow in v1.

## Attachments

Telegram attachments are staged first instead of being forced into the same turn immediately.

- Albums are merged into one saved batch.
- The bridge replies with saved paths and metadata.
- Your next plain-text message can consume that batch automatically.
- You can also trigger `Analyze now` or clear the batch.

This behavior is shared by Codex and Gemini.

## Topic rules

- One topic should contain one bot only.
- Keep Codex and Gemini in separate topics.
- Do not reuse one topic when you replace a bot unless you also update the env binding and restart that instance.
- If several bots share one group, prefer topic names that already show the engine, for example:
  - `linux144-codex`
  - `linux144-gemini`

## Smoke checklist

Per instance:

1. `/status` shows the correct engine and instance id.
2. `/help` exposes only the commands that engine supports.
3. Plain-text turn works.
4. `/interrupt` stops an active turn.
5. A follow-up message queues and resumes.
6. A Telegram image or file is staged and then consumed on the next message.
7. `/restart` restarts only that instance.

Extra Codex checks:

1. `/threads` and `/open` work.
2. `/mode` enters plan mode.
3. Guided plan confirmation, revise, and cancel all work.
4. `/reconnect` refreshes the Codex session.

Extra Gemini checks:

1. Gemini topic responds only through the Gemini bot.
2. Codex-only commands are hidden from slash suggestions.
3. Calling a Codex-only command manually returns a clear unsupported message.

Shared-group checks:

1. Codex bot ignores the Gemini topic.
2. Gemini bot ignores the Codex topic.
3. Both services can run at the same time without sharing state files.

## Finding chat and topic ids

To discover `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID`:

1. Stop the target instance.
2. Send a message in the target group or topic.
3. Open:

```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```

4. Read:
   - `message.chat.id` -> `TG_ALLOWED_CHAT_ID`
   - `message.message_thread_id` -> `TG_ALLOWED_TOPIC_ID`

If the instance is still polling, it may consume the update before you inspect it.
