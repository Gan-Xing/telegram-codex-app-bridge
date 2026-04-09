export interface TelegramScope {
  chatId: string;
  topicId: number | null;
}

const ROOT_TOPIC_KEY = 'root';
const SCOPE_SEPARATOR = '::';

export function createTelegramScopeId(chatId: string, topicId: number | null): string {
  return `${chatId}${SCOPE_SEPARATOR}${topicId ?? ROOT_TOPIC_KEY}`;
}

export function parseTelegramScopeId(scopeId: string): TelegramScope {
  const separatorIndex = scopeId.lastIndexOf(SCOPE_SEPARATOR);
  if (separatorIndex === -1) {
    return { chatId: scopeId, topicId: null };
  }
  const chatId = scopeId.slice(0, separatorIndex);
  const topicPart = scopeId.slice(separatorIndex + SCOPE_SEPARATOR.length);
  if (!chatId) {
    throw new Error(`Invalid Telegram scope id: ${scopeId}`);
  }
  if (topicPart === ROOT_TOPIC_KEY || topicPart === '') {
    return { chatId, topicId: null };
  }
  const topicId = Number.parseInt(topicPart, 10);
  if (!Number.isFinite(topicId)) {
    throw new Error(`Invalid Telegram topic id in scope: ${scopeId}`);
  }
  return { chatId, topicId };
}
