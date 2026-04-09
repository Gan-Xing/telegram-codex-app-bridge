# Telegram Bridge Checklist

Use this checklist whenever the bridge is configured for a Telegram group or topic.

## Mode Selection

Pick one mode before writing `.env`:

- private chat only
- one allowed group
- one allowed topic inside one allowed group

Rules:

- private chat remains available even when group/topic ids are configured
- if multiple bots share one group, prefer one topic per bot
- if a user only wants the bot in private chat, leave both `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID` empty

## Required Values

- `TG_BOT_TOKEN`
- `TG_ALLOWED_USER_ID`
- `DEFAULT_CWD`

Optional values:

- `TG_ALLOWED_CHAT_ID`
- `TG_ALLOWED_TOPIC_ID`

Behavior:

- No `TG_ALLOWED_CHAT_ID`: private-chat mode
- `TG_ALLOWED_CHAT_ID` only: the whole group becomes the default scope
- `TG_ALLOWED_CHAT_ID` + `TG_ALLOWED_TOPIC_ID`: that topic becomes the default scope
- Private chat with `TG_ALLOWED_USER_ID` still works in every mode above

If multiple bots share one group, keep the same `TG_ALLOWED_CHAT_ID` and give each bot a different `TG_ALLOWED_TOPIC_ID`.

## Path Guidance

Best practice:

- keep the bridge repo in a stable path such as `~/telegram-codex-app-bridge`
- point `DEFAULT_CWD` at a directory the user actually wants Codex to work inside, such as `~/workspace`, `~/Documents`, or `~/Dev`
- do not use an ambiguous or disposable path unless the user explicitly wants that

## Group Requirements

Before testing natural-language chat in a group:

1. Add the bot to the target group.
2. Disable the bot's `privacy mode` in `@BotFather`.
3. Promote the bot to administrator.
4. If natural-language messages still do not arrive after the privacy change, remove the bot and add it back.

`/status@botname` can work even when normal group text still does not. Do not treat command success as proof that group natural-language mode is ready.

## Finding Chat And Topic IDs

1. Stop the bridge.
2. Send a message in the target group or topic.
3. Open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`.
4. Read:
   - `message.chat.id` -> `TG_ALLOWED_CHAT_ID`
   - `message.message_thread_id` -> `TG_ALLOWED_TOPIC_ID`

If the bridge is still polling, it may consume the update before you inspect it.

## First Message Smoke Test

After the bridge is started:

1. Private chat mode:
   - send `/help` to the bot in private chat
   - send one plain-language message such as `show /status`
2. Group mode:
   - send `/help` in the configured group or default topic
   - if multiple bots are present, use `@botname`
3. Topic mode:
   - send `/help` inside the configured topic
   - then send one plain-language message inside that same topic

If the bot does not answer:

1. run `node dist/main.js status`
2. inspect the bridge log
3. re-check:
   - bot token
   - allowed user id
   - chat id
   - topic id
   - privacy mode
   - admin status
