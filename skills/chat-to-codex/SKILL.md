---
name: chat-to-codex
description: Deploy, configure, and validate the Gan-Xing Telegram-to-Codex bridge on macOS, locally or over SSH. Use when Codex needs to clone or update the bridge repo, collect Telegram bot and chat/topic values, write the bridge `.env`, enable a launchd service, and guide the user through the first Telegram message test. Trigger on requests about Telegram bots controlling Codex, copying the bridge to another Mac, remote bridge deployment, or turning this repo into an installable Codex skill.
---

# Chat To Codex

Deploy the Telegram Codex bridge to a Mac with as little manual setup as possible. The bundled scripts install user-scoped Node.js and Codex CLI when missing, clone or update the bridge repo, write `.env`, build the project, run doctor checks, and optionally install the launchd service.

This skill is not finished when the repo is merely installed. Treat a bridge setup as complete only after:

1. the repo exists at the target path
2. `.env` contains the correct Telegram values
3. the bridge passes `doctor` and can report `status`
4. the user has been told exactly where to send the first Telegram message
5. the setup has been smoke-tested or clearly blocked by missing Telegram-side values

## Mandatory Workflow

Follow this order every time:

1. Decide whether this is a local Mac install or a remote Mac over SSH.
2. Confirm where the bridge repo should live. If the repo is not already present, clone it or let bootstrap clone it.
3. Decide the Telegram mode before writing `.env`:
   - private chat only
   - one allowed group
   - one allowed topic inside one group
4. Collect the Telegram values and filesystem paths listed below.
5. Run the correct bootstrap script with explicit arguments.
6. Run post-install validation.
7. Tell the user to send a first Telegram message and explain exactly where to send it.
8. If the bridge does not answer, inspect `status`, logs, and Telegram configuration instead of declaring success.

Do not stop after "install completed" if the user asked for a working bot.

## Required Inputs

Collect these values before running bootstrap:

- `TG_BOT_TOKEN`
- `TG_ALLOWED_USER_ID`
- `DEFAULT_CWD`

Collect these values when group/topic mode is used:

- `TG_ALLOWED_CHAT_ID`
- `TG_ALLOWED_TOPIC_ID`

Collect these deployment values on every run:

- install directory
- SSH host when deploying remotely

Defaults:

- repo URL: `https://github.com/Gan-Xing/telegram-codex-app-bridge.git`
- repo ref: `main`
- install directory: `~/telegram-codex-app-bridge`
- `DEFAULT_APPROVAL_POLICY`: `on-request`
- `DEFAULT_SANDBOX_MODE`: `workspace-write`

Telegram behavior:

- private chat with `TG_ALLOWED_USER_ID` remains available even when `TG_ALLOWED_CHAT_ID` or `TG_ALLOWED_TOPIC_ID` is set
- `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID` choose the default group or topic scope; they do not disable private chat

If `TG_ALLOWED_CHAT_ID` or `TG_ALLOWED_TOPIC_ID` is missing, read [references/telegram-setup.md](./references/telegram-setup.md) and explicitly guide the user through collecting it.

## Deployment Rules

1. If the user is deploying to a second Mac, prefer one bot per device.
2. If no unique bot token has been provided for the second Mac, bootstrap with `--no-start`.
3. If group or topic mode is involved, read [references/telegram-setup.md](./references/telegram-setup.md) before continuing.
4. Always explain to the user which values will be written into `.env` before starting bootstrap.
5. After bootstrap, check `codex login status`. If authentication is missing, tell the user to run `codex login` or open `codex app` on that Mac.
6. If the user only says "set it up" and has not given all required values, ask for the missing values directly instead of guessing Telegram IDs.
7. If the user wants a fully usable setup, continue until first-message validation is done or clearly blocked by Telegram-side prerequisites.

## What To Ask The User

Use short direct questions when values are missing. The minimum useful checklist is:

1. Where should the repo live on the target Mac?
2. Which directory should be the bridge's default working directory?
3. What is the Telegram bot token?
4. What is the Telegram numeric user id allowed to control the bridge?
5. Are we using private chat only, a group, or a specific topic?
6. If group/topic mode: what are the `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID` values?

If the user does not know the Telegram ids, point them to the exact `getUpdates` method in [references/telegram-setup.md](./references/telegram-setup.md).

## Local Bootstrap

Run:

```bash
python3 "$CODEX_HOME/skills/chat-to-codex/scripts/bootstrap_host.py" \
  --tg-bot-token "<BOT_TOKEN>" \
  --tg-allowed-user-id "<USER_ID>" \
  --default-cwd "<ABSOLUTE_CWD>" \
  --tg-allowed-chat-id "<CHAT_ID>" \
  --tg-allowed-topic-id "<TOPIC_ID>" \
  --default-sandbox-mode "workspace-write"
```

Omit `--tg-allowed-chat-id` and `--tg-allowed-topic-id` when using private chat only.

Use `--no-start` when you only want the host prepared but do not want the bridge service to start yet.

When the repo is not already present on disk, this bootstrap path counts as the repo download step because it clones the bridge automatically.

## Remote Bootstrap Over SSH

Run:

```bash
python3 "$CODEX_HOME/skills/chat-to-codex/scripts/bootstrap_remote.py" \
  --ssh-host "<USER@HOST>" \
  --install-dir "<REMOTE_INSTALL_DIR>" \
  --tg-bot-token "<BOT_TOKEN>" \
  --tg-allowed-user-id "<USER_ID>" \
  --default-cwd "<REMOTE_ABSOLUTE_CWD>" \
  --tg-allowed-chat-id "<CHAT_ID>" \
  --tg-allowed-topic-id "<TOPIC_ID>" \
  --default-sandbox-mode "workspace-write"
```

Use `--no-start` by default when preparing a second Mac before a unique bot token is ready.

## Validation

After either bootstrap path:

1. Run `node dist/main.js doctor` in the installed bridge repo.
2. If launchd was installed, run `node dist/main.js status`.
3. Check `codex login status`. If authentication is missing, stop and tell the user exactly how to log in.
4. If the bridge is expected to answer in a Telegram group, confirm:
   - `privacy mode` is disabled
   - the bot is an admin in the group
   - the configured `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID` match the target group/topic
5. If group or topic mode is enabled, also verify that private chat still responds for the configured `TG_ALLOWED_USER_ID`.

## First Telegram Message Check

Do this whenever the bridge has been started:

1. Tell the user exactly where to send the first test message:
   - private chat mode: send `/help` to the bot in private chat
   - group mode: send `/help@botname` or `/help` in the configured default scope
   - topic mode: send `/help` inside the configured topic, then send one plain-language message
2. After the user sends that message, verify the bridge is listening:
   - `node dist/main.js status`
   - launchd or service log if there is no reply
3. If the bot still does not answer, debug the Telegram side before changing the bridge:
   - wrong bot token
   - wrong user id
   - wrong chat/topic ids
   - privacy mode still on
   - bot not admin in group

Do not describe the setup as "done" until this smoke test has either passed or been blocked by missing Telegram-side access.

## Resources

- [references/telegram-setup.md](./references/telegram-setup.md): Telegram-side checklist and ID discovery
- `scripts/bootstrap_host.py`: install and configure the bridge on the current Mac
- `scripts/bootstrap_remote.py`: run the same bootstrap on another Mac over SSH
