import { parseTelegramTargetFromBridgeScope } from '../../core/bridge_scope.js';
import type { ChannelPort } from '../../core/channel_port.js';
import type { TelegramGateway } from '../../telegram/gateway.js';
import type { TelegramRemoteFile } from '../../telegram/api.js';

export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

/**
 * Telegram outbound operations addressed by bridge scope id (`telegram:…`).
 */
export class TelegramMessagingPort implements ChannelPort {
  constructor(private readonly gateway: TelegramGateway) {}

  async sendPlain(
    bridgeScopeId: string,
    text: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<number> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    return this.gateway.sendMessage(target.chatId, text, inlineKeyboard, target.topicId);
  }

  async sendHtml(
    bridgeScopeId: string,
    text: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<number> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    return this.gateway.sendHtmlMessage(target.chatId, text, inlineKeyboard, target.topicId);
  }

  async editPlain(
    bridgeScopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.editMessage(target.chatId, messageId, text, inlineKeyboard);
  }

  async editHtml(
    bridgeScopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: InlineKeyboard,
  ): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.editHtmlMessage(target.chatId, messageId, text, inlineKeyboard);
  }

  async deleteMessage(bridgeScopeId: string, messageId: number): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.deleteMessage(target.chatId, messageId);
  }

  async sendTypingInScope(bridgeScopeId: string): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.sendTypingInThread(target.chatId, target.topicId);
  }

  async clearInlineKeyboard(bridgeScopeId: string, messageId: number): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.clearMessageInlineKeyboard(target.chatId, messageId);
  }

  async sendDraft(bridgeScopeId: string, draftId: number, text: string): Promise<void> {
    const target = parseTelegramTargetFromBridgeScope(bridgeScopeId);
    await this.gateway.sendMessageDraft(target.chatId, draftId, text, target.topicId);
  }

  answerCallback(callbackQueryId: string, text: string): Promise<void> {
    return this.gateway.answerCallback(callbackQueryId, text);
  }

  getFile(fileId: string): Promise<TelegramRemoteFile> {
    return this.gateway.getFile(fileId);
  }

  downloadResolvedFile(remoteFilePath: string, destinationPath: string): Promise<number> {
    return this.gateway.downloadResolvedFile(remoteFilePath, destinationPath);
  }
}
