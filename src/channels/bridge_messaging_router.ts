import { BRIDGE_SCOPE_WEIXIN_PREFIX } from '../core/bridge_scope.js';
import type { TelegramRemoteFile } from '../telegram/api.js';
import type { InlineKeyboard, TelegramMessagingPort } from './telegram/telegram_messaging_port.js';
import type { WeixinMessagingPort } from './weixin/weixin_messaging_port.js';

/**
 * Routes outbound calls by `scopeId` prefix: {@link BRIDGE_SCOPE_WEIXIN_PREFIX} vs Telegram.
 * Telegram-only surfaces (callbacks, Bot API files) always use the Telegram port.
 */
export class BridgeMessagingRouter {
  constructor(
    private readonly telegram: TelegramMessagingPort,
    private readonly weixin: WeixinMessagingPort | null,
  ) {}

  get hasWeixinTransport(): boolean {
    return this.weixin !== null;
  }

  private isWeixinScope(scopeId: string): boolean {
    return scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX) && this.weixin !== null;
  }

  sendPlain(scopeId: string, text: string, keyboard?: InlineKeyboard): Promise<number> {
    if (this.isWeixinScope(scopeId)) {
      return this.weixin!.sendPlain(scopeId, text, keyboard);
    }
    return this.telegram.sendPlain(scopeId, text, keyboard);
  }

  sendHtml(scopeId: string, text: string, keyboard?: InlineKeyboard): Promise<number> {
    if (this.isWeixinScope(scopeId)) {
      return this.weixin!.sendHtml(scopeId, text, keyboard);
    }
    return this.telegram.sendHtml(scopeId, text, keyboard);
  }

  editPlain(scopeId: string, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.weixin!.editPlain(scopeId, messageId, text, keyboard);
    }
    return this.telegram.editPlain(scopeId, messageId, text, keyboard);
  }

  editHtml(scopeId: string, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.weixin!.editHtml(scopeId, messageId, text, keyboard);
    }
    return this.telegram.editHtml(scopeId, messageId, text, keyboard);
  }

  deleteMessage(scopeId: string, messageId: number): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.weixin!.deleteMessage(scopeId, messageId);
    }
    return this.telegram.deleteMessage(scopeId, messageId);
  }

  sendTypingInScope(scopeId: string): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.weixin!.sendTypingInScope(scopeId);
    }
    return this.telegram.sendTypingInScope(scopeId);
  }

  clearInlineKeyboard(scopeId: string, messageId: number): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.weixin!.clearInlineKeyboard(scopeId, messageId);
    }
    return this.telegram.clearInlineKeyboard(scopeId, messageId);
  }

  sendDraft(scopeId: string, draftId: number, text: string): Promise<void> {
    if (this.isWeixinScope(scopeId)) {
      return this.weixin!.sendDraft(scopeId, draftId, text);
    }
    return this.telegram.sendDraft(scopeId, draftId, text);
  }

  answerCallback(callbackQueryId: string, text: string): Promise<void> {
    return this.telegram.answerCallback(callbackQueryId, text);
  }

  getFile(fileId: string): Promise<TelegramRemoteFile> {
    return this.telegram.getFile(fileId);
  }

  downloadResolvedFile(remoteFilePath: string, destinationPath: string): Promise<number> {
    return this.telegram.downloadResolvedFile(remoteFilePath, destinationPath);
  }
}
