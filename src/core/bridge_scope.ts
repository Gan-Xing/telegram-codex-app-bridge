import { parseTelegramScopeId, type TelegramScope } from '../telegram/scope.js';

/** Prefix for Telegram-derived bridge session keys (stored in SQLite `chat_id` / `scope_id` columns). */
export const BRIDGE_SCOPE_TELEGRAM_PREFIX = 'telegram:';

/** Weixin iLink scopes: `weixin:<accountId>:<from_user_id>`. */
export const BRIDGE_SCOPE_WEIXIN_PREFIX = 'weixin:';

export interface WeixinBridgeScope {
  accountId: string;
  fromUserId: string;
}

export function isBridgeScopedKey(key: string): boolean {
  return key.startsWith(BRIDGE_SCOPE_TELEGRAM_PREFIX) || key.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX);
}

/** Wrap legacy Telegram inner scope (`chat::topic`) for storage and routing. */
export function toTelegramBridgeScopeId(telegramInnerScopeId: string): string {
  return `${BRIDGE_SCOPE_TELEGRAM_PREFIX}${telegramInnerScopeId}`;
}

/** Strip `telegram:` prefix; returns `null` if not a Telegram bridge scope. */
export function telegramInnerScopeFromBridge(bridgeScopeId: string): string | null {
  if (!bridgeScopeId.startsWith(BRIDGE_SCOPE_TELEGRAM_PREFIX)) {
    return null;
  }
  return bridgeScopeId.slice(BRIDGE_SCOPE_TELEGRAM_PREFIX.length);
}

export function parseTelegramTargetFromBridgeScope(bridgeScopeId: string): TelegramScope {
  const inner = telegramInnerScopeFromBridge(bridgeScopeId);
  if (inner === null) {
    throw new Error(`Expected ${BRIDGE_SCOPE_TELEGRAM_PREFIX} scope, got: ${bridgeScopeId}`);
  }
  return parseTelegramScopeId(inner);
}

/** Parse `weixin:<accountId>:<from_user_id>`; returns `null` if not a Weixin scope. */
export function parseWeixinBridgeScope(bridgeScopeId: string): WeixinBridgeScope | null {
  if (!bridgeScopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
    return null;
  }
  const rest = bridgeScopeId.slice(BRIDGE_SCOPE_WEIXIN_PREFIX.length);
  const firstColon = rest.indexOf(':');
  if (firstColon === -1) {
    return null;
  }
  const accountId = rest.slice(0, firstColon);
  const fromUserId = rest.slice(firstColon + 1);
  if (!accountId || !fromUserId) {
    return null;
  }
  return { accountId, fromUserId };
}

export function toWeixinBridgeScopeId(accountId: string, fromUserId: string): string {
  return `${BRIDGE_SCOPE_WEIXIN_PREFIX}${accountId}:${fromUserId}`;
}
