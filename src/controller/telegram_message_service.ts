import type { TelegramGateway } from '../telegram/gateway.js';
import { parseTelegramScopeId } from '../telegram/scope.js';
import { formatUserError } from './utils.js';

export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

interface MessageBot {
  sendMessage: TelegramGateway['sendMessage'];
  sendHtmlMessage: TelegramGateway['sendHtmlMessage'];
  editMessage: TelegramGateway['editMessage'];
  editHtmlMessage: TelegramGateway['editHtmlMessage'];
  deleteMessage: TelegramGateway['deleteMessage'];
  sendTypingInThread: TelegramGateway['sendTypingInThread'];
  sendMessageDraft: TelegramGateway['sendMessageDraft'];
  clearMessageInlineKeyboard: TelegramGateway['clearMessageInlineKeyboard'];
}

interface TelegramMessageServiceOptions {
  audit?: (direction: 'outbound', scopeId: string, eventType: string, summary: string) => void;
}

export class TelegramMessageService {
  private readonly scopeQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly bot: MessageBot,
    private readonly options: TelegramMessageServiceOptions = {},
  ) {}

  async sendMessage(scopeId: string, text: string, inlineKeyboard?: InlineKeyboard): Promise<number> {
    return this.enqueue(scopeId, async () => {
      const target = parseTelegramScopeId(scopeId);
      const messageId = await this.withTelegramRetries(() => this.bot.sendMessage(target.chatId, text, inlineKeyboard, target.topicId));
      this.audit(scopeId, 'telegram.message', text);
      return messageId;
    });
  }

  async sendHtmlMessage(scopeId: string, text: string, inlineKeyboard?: InlineKeyboard): Promise<number> {
    return this.enqueue(scopeId, async () => {
      const target = parseTelegramScopeId(scopeId);
      const messageId = await this.withTelegramRetries(() => this.bot.sendHtmlMessage(target.chatId, text, inlineKeyboard, target.topicId));
      this.audit(scopeId, 'telegram.html_message', text);
      return messageId;
    });
  }

  async editMessage(scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard): Promise<void> {
    await this.enqueue(scopeId, async () => {
      const target = parseTelegramScopeId(scopeId);
      await this.bot.editMessage(target.chatId, messageId, text, inlineKeyboard);
    });
  }

  async editHtmlMessage(scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard): Promise<void> {
    await this.enqueue(scopeId, async () => {
      const target = parseTelegramScopeId(scopeId);
      await this.bot.editHtmlMessage(target.chatId, messageId, text, inlineKeyboard);
    });
  }

  async deleteMessage(scopeId: string, messageId: number): Promise<void> {
    await this.enqueue(scopeId, async () => {
      const target = parseTelegramScopeId(scopeId);
      await this.bot.deleteMessage(target.chatId, messageId);
    });
  }

  async sendTyping(scopeId: string): Promise<void> {
    await this.enqueue(scopeId, async () => {
      const target = parseTelegramScopeId(scopeId);
      await this.bot.sendTypingInThread(target.chatId, target.topicId);
    });
  }

  async sendDraft(scopeId: string, draftId: number, text: string): Promise<void> {
    await this.enqueue(scopeId, async () => {
      const target = parseTelegramScopeId(scopeId);
      await this.bot.sendMessageDraft(target.chatId, draftId, text, target.topicId);
    });
  }

  async clearMessageButtons(scopeId: string, messageId: number): Promise<void> {
    await this.enqueue(scopeId, async () => {
      const target = parseTelegramScopeId(scopeId);
      await this.bot.clearMessageInlineKeyboard(target.chatId, messageId);
    });
  }

  private enqueue<T>(scopeId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.scopeQueues.get(scopeId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task);
    const settled = next.catch(() => undefined);
    const queued = settled.finally(() => {
      if (this.scopeQueues.get(scopeId) === queued) {
        this.scopeQueues.delete(scopeId);
      }
    });
    this.scopeQueues.set(scopeId, queued);
    return next;
  }

  private async withTelegramRetries<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (isTelegramMessageGone(error)) {
          throw error;
        }
        const retryAfterMs = parseTelegramRetryAfterMs(error);
        if (retryAfterMs !== null) {
          attempt += 1;
          if (attempt > 8) {
            throw error;
          }
          await sleep(retryAfterMs);
          continue;
        }
        if (!isTransientTelegramError(error)) {
          throw error;
        }
        attempt += 1;
        if (attempt > 4) {
          throw error;
        }
        await sleep(300 * attempt);
      }
    }
  }

  private audit(scopeId: string, eventType: string, text: string): void {
    this.options.audit?.('outbound', scopeId, eventType, summarizeAuditText(text));
  }
}

export function isTelegramMessageGone(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message to delete not found')
    || message.includes('message to edit not found')
    || message.includes('message not found');
}

function parseTelegramRetryAfterMs(error: unknown): number | null {
  const message = formatUserError(error).toLowerCase();
  const match = message.match(/retry after\s+(\d+)/i);
  if (!match?.[1]) {
    return null;
  }
  const seconds = Number.parseInt(match[1], 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return seconds * 1000;
}

function isTransientTelegramError(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('timed out')
    || message.includes('econnreset')
    || message.includes('socket hang up')
    || message.includes('temporary failure')
    || message.includes('etimedout')
    || message.includes('network');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeAuditText(text: string, limit = 400): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}
