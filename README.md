# telegram-codex-app-bridge

Use a Telegram bot to control a local Codex host through `codex app-server`.

## Features

- Telegram private chat or topic-aware group control for a single allowed user
- Local `codex app-server` transport over loopback WebSocket
- Sticky chat-to-thread binding with `/threads`, `/open`, `/new`, `/where`, `/interrupt`
- Optional Telegram WebApp thread panel with fixed `70/30` Open/Rename button layout
- Chat-scoped model and reasoning-effort control with `/models` and optional `/model`/`/effort` aliases
- Chat-scoped conversation mode control with `/mode` and optional `/plan` alias
- Chat-scoped access presets with `/permissions` and optional `/access` alias
- Unified `/settings` home for model, mode, access, queue, and plan-history controls
- Deep-link sync into the local Codex desktop host with `/open` and `/reveal` when the host supports it
- Guided plan sessions with a mandatory confirm-or-revise gate before execution in `plan` mode
- Plan streaming with a single live plan card, version tracking, and restart-safe recovery prompts
- Inline approval cards with summary, risk level, and detail/back views for command and file-change approvals
- Interactive `request_user_input` flow with button-first choices, recommended-first options, review/back/cancel controls, and optional custom answers
- FIFO follow-up queue with `/queue`, automatic resume, and startup recovery for interrupted queued items
- SQLite persistence for bindings, offsets, approvals, and audit logs
- Stable segmented live rendering across private chat and topic/group modes
- Bottom activity cards for `thinking`, `browsing`, `approval`, `interrupt`, and tool summaries
- Single-instance process lock to prevent duplicate Telegram polling on the same bot token

## Requirements

- macOS or Linux
- `codex` CLI available and authenticated
- Node.js 24+
- A Telegram bot token from `@BotFather`
- Your Telegram numeric user id

Notes:

- The bridge core runs through `codex app-server`.
- `/open` and `/reveal` are best-effort desktop features and depend on the current host's desktop-open capability.

## Setup

1. Install dependencies and write `.env`.
2. Build the bridge.
3. Choose either a foreground run or a host-native user service.

Foreground run:

```bash
npm install
cp .env.example .env
npm run build
npm run doctor
npm run serve
```

Host-native user service:

- macOS: `./scripts/service/install.sh` installs a user `launchd` agent
- Linux: `./scripts/service/install.sh` installs a user `systemd` unit

After install, use:

```bash
./scripts/service/status.sh
./scripts/service/logs.sh
./scripts/service/restart-safe.sh
```

`restart-safe.sh` runs build + restart in sequence, waits until runtime status reports `running=true` and `connected=true`, then sends a Telegram callback message (success/failure with timestamp, commit, and pid).

Useful environment overrides:

```bash
BUILD_BEFORE_RESTART=false ./scripts/service/restart-safe.sh
RESTART_TIMEOUT_SEC=180 RESTART_POLL_SEC=3 ./scripts/service/restart-safe.sh
NOTIFY_TELEGRAM=false ./scripts/service/restart-safe.sh
NOTIFY_TARGET=group ./scripts/service/restart-safe.sh
NOTIFY_CHAT_ID=123456789 ./scripts/service/restart-safe.sh
DETACH=true BUILD_BEFORE_RESTART=false ./scripts/service/restart-safe.sh
```

`DETACH=true` launches a transient user-systemd job (`systemd-run --user`) so restart completion and Telegram callbacks still happen even if the current terminal/chat session is interrupted.
`NOTIFY_TARGET` defaults to `auto`: it replies to the most recent inbound Telegram scope recorded by the bridge, so private-chat activity gets a private callback and topic activity gets a topic callback. If no recent scope is available, it falls back to the configured private chat / group defaults.

## Codex Skill

This repo also ships a Codex skill at [`skills/chat-to-codex`](./skills/chat-to-codex).

Use it when you want Codex to:

- bootstrap this bridge on the current macOS or Linux host
- copy the same setup to another host over SSH
- install Node.js 24 and the Codex CLI
- write the bridge `.env`, build the repo, run doctor, and optionally install the host-native user service

## Telegram Setup

1. Create a bot with `@BotFather` and copy the bot token into `TG_BOT_TOKEN`.
2. Get your Telegram numeric user id and place it into `TG_ALLOWED_USER_ID`.
3. Optional for group/topic mode: add `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID`.
4. Start the bridge locally with `npm run serve`.
5. Open a private chat with the bot and send `/help`, or talk to it in the configured Telegram topic.

The bridge accepts messages only from the configured Telegram user id.

## Interaction Modes

The bridge intentionally uses different Telegram renderers depending on the conversation type:

| Conversation type | Renderer | Notes |
| --- | --- | --- |
| Private chat | Segmented live messages + bottom status card | Default stable renderer; keeps partial output visible |
| Private chat topic | Segmented live messages + bottom status card | Same as private chat, but with `message_thread_id` |
| Group topic | Segmented messages + bottom status card | Fallback mode; no draft streaming |
| Group chat without topic | Segmented messages + bottom status card | Supported, but less structured than topic mode |

Practical guidance:

- Prefer private chat if you want the simplest and most stable live experience.
- Prefer one bot per topic if you keep multiple bots in the same group.
- Group/topic mode is a compatibility path, not the richest renderer.

## Configuration Model

Each device only needs one bot and one `.env` file. Use the same template in all cases:

```dotenv
TG_BOT_TOKEN=123456:telegram-token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=
TG_ALLOWED_TOPIC_ID=
TG_WEBAPP_BASE_URL=
WEBAPP_BIND_HOST=127.0.0.1
WEBAPP_BIND_PORT=8787
CODEX_APP_AUTOLAUNCH=false
CODEX_APP_LAUNCH_CMD=
CODEX_APP_SYNC_ON_OPEN=true
CODEX_APP_SYNC_ON_TURN_COMPLETE=false
DEFAULT_CWD=/absolute/path/to/workspace
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

Keep `CODEX_APP_AUTOLAUNCH=false` unless you have a known-good desktop launch command for that host.

How the optional Telegram fields work:

- Leave `TG_ALLOWED_CHAT_ID` empty: private-chat mode
- Set `TG_ALLOWED_CHAT_ID` only: one allowed group becomes the default conversation scope
- Set both `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID`: that topic becomes the default conversation scope

If multiple bots share one group, each bot should use:

- Its own `TG_BOT_TOKEN`
- The same `TG_ALLOWED_CHAT_ID`
- A different `TG_ALLOWED_TOPIC_ID`

Without `TG_ALLOWED_TOPIC_ID`, every bot in the same group treats the whole group as its default scope.

Optional WebApp threads panel:

- Set `TG_WEBAPP_BASE_URL` to the public base URL that Telegram clients can reach.
- The bridge serves the panel at `/webapp/threads` on `WEBAPP_BIND_HOST:WEBAPP_BIND_PORT`.
- Typical deployment: reverse proxy `https://your-domain/...` to the local WebApp server.

## Commands

- `/help`
- `/status`
- `/threads [query]`
- `/open <n>`
- `/new [cwd]`
- `/models` opens the model and reasoning picker
- `/mode` opens the conversation-mode picker (`default`, `plan`)
- `/settings` opens the unified settings home
- `/queue [next|clear]` shows or trims queued follow-up messages
- `/permissions` opens the access preset picker (`read-only`, `default`, `full-access`)
- `/model` and `/effort` are compatibility aliases for the same picker
- `/plan` is a compatibility alias for switching to plan mode
- `/access` is a compatibility alias for `/permissions`
- `/reveal`
- `/where`
- `/interrupt`
- Plain text sends to the current thread, or creates a new one if none is bound.
- When a turn is already running and auto-queue is enabled, the new message is normalized, queued, and resumed automatically in FIFO order.

## Guided Plan Flow

When a chat is in `plan` mode, the bridge intentionally adds one layer on top of raw Codex plan mode:

1. The first turn is draft-only. Codex can inspect context and build a plan, but the bridge blocks execution until you confirm.
2. Telegram keeps one plan card updated as `item/plan/delta` and `turn/plan/updated` arrive.
3. Once the draft is stable, you get `Continue (Recommended)`, `Revise`, and `Cancel`.
4. After confirmation, Codex can execute and ask focused follow-up questions with 2-3 options, a recommended first choice, and a review/back/cancel step before submit.
5. If the bridge restarts, recovery cards restore pending plan confirmation, approvals, input prompts, and queued follow-ups.

This is the closest approximation of Codex App that fits Telegram's linear chat surface.

Resolved guided-plan history is retained conservatively: the bridge keeps up to the 20 most recent resolved plan sessions per chat and prunes resolved records older than 30 days during startup. If `Persist plan history` is turned off in `/settings`, resolved plan sessions for that chat are dropped on the next startup cleanup pass.

## Telegram Group Checklist

If you use a group or supergroup, do all of the following before testing natural-language chat:

1. Add the bot to the target group.
2. Disable the bot's `privacy mode` in `@BotFather`.
3. Promote the bot to administrator in that group.
4. If you disabled `privacy mode` after the bot was already in the group and natural-language messages still do not arrive, remove the bot and add it back.

Notes:

- `privacy mode` is not required for private chat.
- `/status@botname` and other explicit commands may work even when natural-language group messages do not. Do not use command success as proof that group natural-language mode is configured correctly.
- Topic mode is optional. It is recommended when multiple bots share one group.

## Recommended Usage

The bridge supports three practical layouts:

- Private chat: simplest setup, no group, no topic
- Single bot in one group: set `TG_ALLOWED_CHAT_ID`, keep `TG_ALLOWED_TOPIC_ID` empty unless you want a default topic
- Multiple bots in one group: recommended to use one topic per bot

Recommended group behavior:

- In the bot's default topic, send natural-language messages directly
- In `General` or other topics, explicitly address the bot with `@botname` or `/command@botname`

## Behavior Boundaries

What is intentionally supported now:

- Private chats and topics use segmented live messages so visible partial output is not overwritten by generic status text
- Group topics use segmented messages, activity cards, and archived tool summaries
- Tool actions such as `Read ...`, `Searched for ...`, `Ran ...`, and edit operations are summarized separately from the assistant body
- Guided plan mode can hold execution behind a confirm/revise gate, render live plan updates, pause on interactive questions, and resume after restart
- Follow-up messages can queue behind an active turn instead of being dropped
- Approval cards can expand into a detail view with risk and path summaries
- Interrupt and approval states are shown as their own activity states instead of being mixed into generic "working" text

What still remains an approximation of Codex App:

- Telegram does not give this bridge the same native multi-panel surface as Codex App, so activity and body still share one linear chat timeline
- If Telegram or the network briefly fails, the bridge retries rendering, but the UI can still be less fluid than Codex App
- A bridge restart can recover pending plan/input/approval state, but it still cannot reconstruct every in-flight text delta exactly

## Finding Chat And Topic IDs

To discover `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID`:

1. Stop the bridge.
2. Send a message in the target group or topic.
3. Open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`.
4. Read:
   - `message.chat.id` -> `TG_ALLOWED_CHAT_ID`
   - `message.message_thread_id` -> `TG_ALLOWED_TOPIC_ID`

If the bridge is still running, it may consume the update before you inspect it.

## Example Group Config

```dotenv
TG_BOT_TOKEN=123456:telegram-token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=-1001234567890
TG_ALLOWED_TOPIC_ID=42
CODEX_APP_AUTOLAUNCH=false
CODEX_APP_LAUNCH_CMD=
CODEX_APP_SYNC_ON_OPEN=true
CODEX_APP_SYNC_ON_TURN_COMPLETE=false
DEFAULT_CWD=/absolute/path/to/workspace
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

This is the common setup for one bot bound to one topic inside one group.

## Troubleshooting

Common issues:

- Group command works, but natural language does not:
  Usually `privacy mode` is still on, the bot is not admin, or the bot needs to be re-added after the privacy change.
- `getUpdates` shows no recent message:
  Stop the bridge first, then send a fresh message and check again.
- Multiple bots answer in the same group:
  Give each bot a different `TG_ALLOWED_TOPIC_ID`, or keep bots in separate groups.
- The same bot starts replying twice or Telegram shows polling conflicts:
  Make sure only one bridge process is running for that bot. This repo now uses a local lock file to block a second instance on the same Mac.
- A message seemed to get no reply:
  Check the latest activity card and streamed body below it. The bridge keeps partial output visible instead of replacing it with a generic loading line.

See [`.env.example`](./.env.example) for the full list.

## Operations

```bash
npm run build
./scripts/doctor.sh
./scripts/status.sh
./scripts/service/install.sh
./scripts/service/status.sh
./scripts/service/logs.sh
```

## Contributing

Issues and PRs are welcome. Keep changes small, tested, and documented.
