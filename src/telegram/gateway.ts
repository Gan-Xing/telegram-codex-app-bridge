import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { callTelegramApi, downloadTelegramFile, getTelegramFile, type TelegramRemoteFile } from './api.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import { getTelegramCommands } from '../i18n.js';
import { createTelegramScopeId } from './scope.js';
import type { TelegramMessageEntity } from './addressing.js';
import type { TelegramInboundAttachment } from './media.js';

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  language_code?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  username?: string;
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
  video_note?: TelegramVideoNote;
  web_app_data?: TelegramWebAppData;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface GetMeResult {
  id: number;
  username?: string;
}

interface SendMessageResult {
  message_id: number;
}

interface TelegramWebAppData {
  button_text?: string;
  data: string;
}

interface TelegramCallbackButton {
  text: string;
  callback_data: string;
}

interface TelegramWebAppButton {
  text: string;
  web_app: { url: string };
}

type TelegramInlineButton = TelegramCallbackButton | TelegramWebAppButton;

export interface TelegramTextEvent {
  chatId: string;
  topicId: number | null;
  scopeId: string;
  chatType: string;
  userId: string;
  text: string;
  messageId: number;
  attachments: TelegramInboundAttachment[];
  entities: TelegramMessageEntity[];
  replyToBot: boolean;
  languageCode?: string;
}

export interface TelegramCallbackEvent {
  chatId: string;
  topicId: number | null;
  scopeId: string;
  userId: string;
  data: string;
  callbackQueryId: string;
  messageId: number;
  languageCode?: string;
}

export interface TelegramWebAppEvent {
  chatId: string;
  topicId: number | null;
  scopeId: string;
  userId: string;
  data: string;
  messageId: number;
  buttonText: string | null;
  languageCode?: string;
}

export class TelegramGateway extends EventEmitter {
  private running = false;
  private botKey: string;
  private botUsername: string | null = null;
  private botUserId: number | null = null;

  constructor(
    private readonly botToken: string,
    private readonly allowedUserId: string,
    private readonly allowedChatId: string | null,
    private readonly pollIntervalMs: number,
    private readonly store: BridgeStore,
    private readonly logger: Logger,
  ) {
    super();
    this.botKey = `telegram:${crypto.createHash('sha256').update(this.botToken).digest('hex').slice(0, 8)}`;
  }

  get username(): string | null {
    return this.botUsername;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.resolveBotIdentity();
    await this.registerCommands();
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
  }

  async sendMessage(
    chatId: string,
    text: string,
    inlineKeyboard?: Array<Array<TelegramCallbackButton>>,
    messageThreadId?: number | null,
  ): Promise<number> {
    return this.sendMessageWithOptions(chatId, text, inlineKeyboard, undefined, messageThreadId);
  }

  async sendHtmlMessage(
    chatId: string,
    text: string,
    inlineKeyboard?: Array<Array<TelegramCallbackButton>>,
    messageThreadId?: number | null,
  ): Promise<number> {
    return this.sendMessageWithOptions(chatId, text, inlineKeyboard, 'HTML', messageThreadId);
  }

  async sendHtmlMessageWithWebAppButton(
    chatId: string,
    text: string,
    buttonText: string,
    url: string,
    messageThreadId?: number | null,
  ): Promise<number> {
    return this.sendMessageWithOptions(
      chatId,
      text,
      [[{ text: buttonText, web_app: { url } }]],
      'HTML',
      messageThreadId,
    );
  }

  async sendMessageDraft(
    chatId: string,
    draftId: number,
    text: string,
    messageThreadId?: number | null,
  ): Promise<void> {
    const result = await callTelegramApi<boolean>(this.botToken, 'sendMessageDraft', {
      chat_id: chatId,
      draft_id: draftId,
      text,
      ...(messageThreadId !== null && messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
      disable_web_page_preview: true,
    });
    if (!result.ok) {
      throw new Error(result.description || 'Failed to send Telegram draft message');
    }
  }

  async editMessage(chatId: string, messageId: number, text: string, inlineKeyboard?: Array<Array<TelegramCallbackButton>>): Promise<void> {
    return this.editMessageWithOptions(chatId, messageId, text, inlineKeyboard);
  }

  async editHtmlMessage(chatId: string, messageId: number, text: string, inlineKeyboard?: Array<Array<TelegramCallbackButton>>): Promise<void> {
    return this.editMessageWithOptions(chatId, messageId, text, inlineKeyboard, 'HTML');
  }

  async editHtmlMessageWithWebAppButton(
    chatId: string,
    messageId: number,
    text: string,
    buttonText: string,
    url: string,
  ): Promise<void> {
    return this.editMessageWithOptions(
      chatId,
      messageId,
      text,
      [[{ text: buttonText, web_app: { url } }]],
      'HTML',
    );
  }

  async clearMessageInlineKeyboard(chatId: string, messageId: number): Promise<void> {
    const result = await callTelegramApi(this.botToken, 'editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
    if (!result.ok && !String(result.description || '').includes('message is not modified')) {
      throw new Error(result.description || 'Failed to clear Telegram message reply markup');
    }
  }

  private async sendMessageWithOptions(
    chatId: string,
    text: string,
    inlineKeyboard?: Array<Array<TelegramInlineButton>>,
    parseMode?: 'HTML',
    messageThreadId?: number | null,
  ): Promise<number> {
    const result = await callTelegramApi<SendMessageResult>(this.botToken, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(messageThreadId !== null && messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
      ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
      ...(parseMode ? { parse_mode: parseMode } : {}),
      disable_web_page_preview: true,
    });
    if (!result.ok || !result.result) {
      throw new Error(result.description || 'Failed to send Telegram message');
    }
    return result.result.message_id;
  }

  private async editMessageWithOptions(
    chatId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: Array<Array<TelegramInlineButton>>,
    parseMode?: 'HTML',
  ): Promise<void> {
    const result = await callTelegramApi(this.botToken, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
      ...(parseMode ? { parse_mode: parseMode } : {}),
      disable_web_page_preview: true,
    });
    if (!result.ok && !String(result.description || '').includes('message is not modified')) {
      throw new Error(result.description || 'Failed to edit Telegram message');
    }
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    const result = await callTelegramApi(this.botToken, 'deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
    if (!result.ok) {
      throw new Error(result.description || 'Failed to delete Telegram message');
    }
  }

  async answerCallback(callbackQueryId: string, text = 'OK'): Promise<void> {
    await callTelegramApi(this.botToken, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async sendTyping(chatId: string): Promise<void> {
    await callTelegramApi(this.botToken, 'sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    });
  }

  async sendTypingInThread(chatId: string, messageThreadId?: number | null): Promise<void> {
    await callTelegramApi(this.botToken, 'sendChatAction', {
      chat_id: chatId,
      ...(messageThreadId !== null && messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
      action: 'typing',
    });
  }

  async getFile(fileId: string): Promise<TelegramRemoteFile> {
    return getTelegramFile(this.botToken, fileId);
  }

  async downloadResolvedFile(remoteFilePath: string, destinationPath: string): Promise<number> {
    return downloadTelegramFile(this.botToken, remoteFilePath, destinationPath);
  }

  private async resolveBotIdentity(): Promise<void> {
    const result = await callTelegramApi<GetMeResult>(this.botToken, 'getMe', {});
    if (result.ok && result.result) {
      this.botKey = `telegram:bot${result.result.id}`;
      this.botUserId = result.result.id;
      this.botUsername = result.result.username ?? null;
    }
  }

  private async registerCommands(): Promise<void> {
    await callTelegramApi(this.botToken, 'setMyCommands', {
      commands: getTelegramCommands('zh'),
    });
    await callTelegramApi(this.botToken, 'setMyCommands', {
      commands: getTelegramCommands('en'),
      language_code: 'en',
    });
    await callTelegramApi(this.botToken, 'setMyCommands', {
      commands: getTelegramCommands('zh'),
      language_code: 'zh',
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const offset = this.store.getTelegramOffset(this.botKey) + 1;
        const result = await callTelegramApi<TelegramUpdate[]>(this.botToken, 'getUpdates', {
          timeout: Math.max(1, Math.floor(this.pollIntervalMs / 1000)),
          offset,
          allowed_updates: ['message', 'callback_query']
        });
        if (!result.ok || !result.result) {
          this.logger.warn('telegram.getUpdates failed', result.description);
          await sleep(this.pollIntervalMs);
          continue;
        }
        for (const update of result.result) {
          this.store.setTelegramOffset(this.botKey, update.update_id);
          await this.handleUpdate(update);
        }
      } catch (error) {
        this.logger.error('telegram.pollLoop error', toErrorMeta(error));
        await sleep(this.pollIntervalMs);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message && update.message.from && this.isAllowedChat(update.message.chat)) {
      if (String(update.message.from.id) !== this.allowedUserId) return;
      const attachments = extractAttachments(update.message);
      const text = update.message.text ?? update.message.caption ?? '';
      const topicId = update.message.message_thread_id ?? null;
      const scopeId = createTelegramScopeId(String(update.message.chat.id), topicId);
      const entities = update.message.text ? (update.message.entities ?? []) : (update.message.caption_entities ?? []);
      const replyToBot = this.botUserId !== null && update.message.reply_to_message?.from?.id === this.botUserId;
      const webAppData = update.message.web_app_data?.data ?? '';
      if (webAppData.trim()) {
        this.emit('webapp', {
          chatId: String(update.message.chat.id),
          topicId,
          scopeId,
          userId: String(update.message.from.id),
          data: webAppData,
          messageId: update.message.message_id,
          buttonText: update.message.web_app_data?.button_text?.trim() || null,
          ...(update.message.from.language_code ? { languageCode: update.message.from.language_code } : {}),
        } satisfies TelegramWebAppEvent);
        return;
      }
      if (text || attachments.length > 0) {
        this.emit('text', {
          chatId: String(update.message.chat.id),
          topicId,
          scopeId,
          chatType: update.message.chat.type,
          userId: String(update.message.from.id),
          text,
          messageId: update.message.message_id,
          attachments,
          entities,
          replyToBot,
          ...(update.message.from.language_code ? { languageCode: update.message.from.language_code } : {}),
        } satisfies TelegramTextEvent);
        return;
      }
    }

    if (update.callback_query?.data && update.callback_query.from && update.callback_query.message) {
      if (String(update.callback_query.from.id) !== this.allowedUserId) return;
      if (!this.isAllowedChat(update.callback_query.message.chat)) return;
      const topicId = update.callback_query.message.message_thread_id ?? null;
      this.emit('callback', {
        chatId: String(update.callback_query.message.chat.id),
        topicId,
        scopeId: createTelegramScopeId(String(update.callback_query.message.chat.id), topicId),
        userId: String(update.callback_query.from.id),
        data: update.callback_query.data,
        callbackQueryId: update.callback_query.id,
        messageId: update.callback_query.message.message_id,
        ...(update.callback_query.from.language_code ? { languageCode: update.callback_query.from.language_code } : {}),
      } satisfies TelegramCallbackEvent);
    }
  }

  private isAllowedChat(chat: TelegramChat): boolean {
    if (chat.type === 'private') {
      return true;
    }
    if (this.allowedChatId) {
      return String(chat.id) === this.allowedChatId;
    }
    return false;
  }
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration?: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
  duration?: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAnimation {
  file_id: string;
  file_unique_id: string;
  width?: number;
  height?: number;
  duration?: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramSticker {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  is_animated?: boolean;
  is_video?: boolean;
  file_size?: number;
}

interface TelegramVideoNote {
  file_id: string;
  file_unique_id: string;
  length?: number;
  duration?: number;
  file_size?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractAttachments(message: TelegramMessage): TelegramInboundAttachment[] {
  const attachments: TelegramInboundAttachment[] = [];

  const largestPhoto = pickLargestPhoto(message.photo ?? []);
  if (largestPhoto) {
    attachments.push({
      kind: 'photo',
      fileId: largestPhoto.file_id,
      fileUniqueId: largestPhoto.file_unique_id,
      fileName: null,
      mimeType: 'image/jpeg',
      fileSize: largestPhoto.file_size ?? null,
      width: largestPhoto.width,
      height: largestPhoto.height,
      durationSeconds: null,
      isAnimated: false,
      isVideo: false,
    });
  }

  if (message.document) {
    attachments.push({
      kind: 'document',
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id,
      fileName: message.document.file_name ?? null,
      mimeType: message.document.mime_type ?? null,
      fileSize: message.document.file_size ?? null,
      width: null,
      height: null,
      durationSeconds: null,
      isAnimated: false,
      isVideo: false,
    });
  }

  if (message.audio) {
    attachments.push({
      kind: 'audio',
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id,
      fileName: message.audio.file_name ?? null,
      mimeType: message.audio.mime_type ?? null,
      fileSize: message.audio.file_size ?? null,
      width: null,
      height: null,
      durationSeconds: message.audio.duration ?? null,
      isAnimated: false,
      isVideo: false,
    });
  }

  if (message.voice) {
    attachments.push({
      kind: 'voice',
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id,
      fileName: null,
      mimeType: message.voice.mime_type ?? null,
      fileSize: message.voice.file_size ?? null,
      width: null,
      height: null,
      durationSeconds: message.voice.duration ?? null,
      isAnimated: false,
      isVideo: false,
    });
  }

  if (message.video) {
    attachments.push({
      kind: 'video',
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id,
      fileName: message.video.file_name ?? null,
      mimeType: message.video.mime_type ?? null,
      fileSize: message.video.file_size ?? null,
      width: message.video.width ?? null,
      height: message.video.height ?? null,
      durationSeconds: message.video.duration ?? null,
      isAnimated: false,
      isVideo: true,
    });
  }

  if (message.animation) {
    attachments.push({
      kind: 'animation',
      fileId: message.animation.file_id,
      fileUniqueId: message.animation.file_unique_id,
      fileName: message.animation.file_name ?? null,
      mimeType: message.animation.mime_type ?? null,
      fileSize: message.animation.file_size ?? null,
      width: message.animation.width ?? null,
      height: message.animation.height ?? null,
      durationSeconds: message.animation.duration ?? null,
      isAnimated: true,
      isVideo: message.animation.mime_type?.startsWith('video/') ?? false,
    });
  }

  if (message.sticker) {
    attachments.push({
      kind: 'sticker',
      fileId: message.sticker.file_id,
      fileUniqueId: message.sticker.file_unique_id,
      fileName: null,
      mimeType: null,
      fileSize: message.sticker.file_size ?? null,
      width: message.sticker.width,
      height: message.sticker.height,
      durationSeconds: null,
      isAnimated: message.sticker.is_animated ?? false,
      isVideo: message.sticker.is_video ?? false,
    });
  }

  if (message.video_note) {
    attachments.push({
      kind: 'videoNote',
      fileId: message.video_note.file_id,
      fileUniqueId: message.video_note.file_unique_id,
      fileName: null,
      mimeType: 'video/mp4',
      fileSize: message.video_note.file_size ?? null,
      width: message.video_note.length ?? null,
      height: message.video_note.length ?? null,
      durationSeconds: message.video_note.duration ?? null,
      isAnimated: false,
      isVideo: true,
    });
  }

  return attachments;
}

function pickLargestPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize | null {
  if (photos.length === 0) return null;
  return photos.reduce((current, candidate) => {
    const currentArea = current.width * current.height;
    const candidateArea = candidate.width * candidate.height;
    if (candidateArea !== currentArea) {
      return candidateArea > currentArea ? candidate : current;
    }
    return (candidate.file_size ?? 0) > (current.file_size ?? 0) ? candidate : current;
  });
}

function toErrorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
