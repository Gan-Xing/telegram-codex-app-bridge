# Telegram Bridge Checklist

Use this checklist whenever the bridge is configured for a Telegram group or topic.

## Required Values

- `TG_BOT_TOKEN`
- `TG_ALLOWED_USER_ID`

Optional values:

- `TG_ALLOWED_CHAT_ID`
- `TG_ALLOWED_TOPIC_ID`

Behavior:

- No `TG_ALLOWED_CHAT_ID`: private-chat mode
- `TG_ALLOWED_CHAT_ID` only: the whole group becomes the default scope
- `TG_ALLOWED_CHAT_ID` + `TG_ALLOWED_TOPIC_ID`: that topic becomes the default scope
- Private chat with `TG_ALLOWED_USER_ID` still works in every mode above

If multiple bots share one group, keep the same `TG_ALLOWED_CHAT_ID` and give each bot a different `TG_ALLOWED_TOPIC_ID`.

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
