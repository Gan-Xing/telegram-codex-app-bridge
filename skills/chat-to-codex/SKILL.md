---
name: chat-to-codex
description: Deploy and maintain the Gan-Xing Telegram-to-Codex bridge on macOS, locally or over SSH. Use when Codex needs to clone or update the bridge repo, install Node.js 24 and the Codex CLI without Homebrew, write the bridge `.env`, enable a launchd service, or repeat the same setup on another Mac. Trigger on requests about Telegram bots controlling Codex, copying the bridge to another Mac, remote bridge deployment, or turning this repo into an installable Codex skill.
---

# Chat To Codex

Deploy the Telegram Codex bridge to a Mac with as little manual setup as possible. The bundled scripts install user-scoped Node.js and Codex CLI when missing, clone or update the bridge repo, write `.env`, build the project, run doctor checks, and optionally install the launchd service.

## Required Inputs

Collect these values before running the bootstrap scripts:

- `TG_BOT_TOKEN`
- `TG_ALLOWED_USER_ID`
- `DEFAULT_CWD`

Optional values:

- `TG_ALLOWED_CHAT_ID`
- `TG_ALLOWED_TOPIC_ID`
- install directory
- SSH host

Defaults:

- repo URL: `https://github.com/Gan-Xing/telegram-codex-app-bridge.git`
- repo ref: `main`
- install directory: `~/telegram-codex-app-bridge`

Telegram behavior:

- private chat with `TG_ALLOWED_USER_ID` remains available even when `TG_ALLOWED_CHAT_ID` or `TG_ALLOWED_TOPIC_ID` is set
- `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID` choose the default group or topic scope; they do not disable private chat

## Deployment Rules

1. If the user is deploying to a second Mac, prefer one bot per device.
2. If no unique bot token has been provided for the second Mac, bootstrap with `--no-start`.
3. If group or topic mode is involved, read [references/telegram-setup.md](./references/telegram-setup.md) before continuing.
4. After bootstrap, check `codex login status`. If authentication is missing, tell the user to run `codex login` or open `codex app` on that Mac.

## Local Bootstrap

Run:

```bash
python3 "$CODEX_HOME/skills/chat-to-codex/scripts/bootstrap_host.py" \
  --tg-bot-token "<BOT_TOKEN>" \
  --tg-allowed-user-id "<USER_ID>" \
  --default-cwd "<ABSOLUTE_CWD>" \
  --tg-allowed-chat-id "<CHAT_ID>" \
  --tg-allowed-topic-id "<TOPIC_ID>"
```

Omit `--tg-allowed-chat-id` and `--tg-allowed-topic-id` when using private chat only.

Use `--no-start` when you only want the host prepared but do not want the bridge service to start yet.

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
  --tg-allowed-topic-id "<TOPIC_ID>"
```

Use `--no-start` by default when preparing a second Mac before a unique bot token is ready.

## Validation

After either bootstrap path:

1. Run `node dist/main.js doctor` in the installed bridge repo.
2. If launchd was installed, run `node dist/main.js status`.
3. If the bridge is expected to answer in a Telegram group, confirm:
   - `privacy mode` is disabled
   - the bot is an admin in the group
   - the configured `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID` match the target group/topic
4. If group or topic mode is enabled, also verify that private chat still responds for the configured `TG_ALLOWED_USER_ID`.

## Resources

- [references/telegram-setup.md](./references/telegram-setup.md): Telegram-side checklist and ID discovery
- `scripts/bootstrap_host.py`: install and configure the bridge on the current Mac
- `scripts/bootstrap_remote.py`: run the same bootstrap on another Mac over SSH
