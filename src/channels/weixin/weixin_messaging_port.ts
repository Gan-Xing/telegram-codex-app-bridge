import { parseWeixinBridgeScope } from '../../core/bridge_scope.js';
import type { BridgeStore } from '../../store/database.js';
import { sendMessageWeixin } from './ilink/send.js';
import type { WeixinSavedAccount } from './account_store.js';
import type { ChannelInlineKeyboard } from '../../core/channel_port.js';

function stripHtmlBasic(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Weixin (iLink) outbound: addressed by `weixin:<accountId>:<peerUserId>` scope ids.
 * Editing/deleting Telegram messages is approximated as new plain text sends or no-ops.
 */
export class WeixinMessagingPort {
  private nextSyntheticId = 1;

  constructor(
    private readonly store: BridgeStore,
    private readonly loadAccount: (accountId: string) => WeixinSavedAccount | null,
  ) {}

  private allocMessageId(): number {
    const id = this.nextSyntheticId;
    this.nextSyntheticId += 1;
    return id;
  }

  async sendPlain(scopeId: string, text: string, keyboard?: ChannelInlineKeyboard): Promise<number> {
    void keyboard;
    const parsed = parseWeixinBridgeScope(scopeId);
    if (!parsed) {
      throw new Error(`Invalid weixin scope: ${scopeId}`);
    }
    const account = this.loadAccount(parsed.accountId);
    if (!account) {
      throw new Error(`Weixin account not found: ${parsed.accountId}`);
    }
    const contextToken = this.store.getWeixinContextToken(scopeId);
    await sendMessageWeixin({
      to: parsed.fromUserId,
      text,
      opts: {
        baseUrl: account.baseUrl,
        token: account.botToken,
        ...(contextToken !== null && contextToken !== '' ? { contextToken } : {}),
      },
    });
    return this.allocMessageId();
  }

  async sendHtml(scopeId: string, html: string, keyboard?: ChannelInlineKeyboard): Promise<number> {
    return this.sendPlain(scopeId, stripHtmlBasic(html), keyboard);
  }

  async editPlain(scopeId: string, _messageId: number, text: string, keyboard?: ChannelInlineKeyboard): Promise<void> {
    await this.sendPlain(scopeId, text, keyboard);
  }

  async editHtml(scopeId: string, messageId: number, html: string, keyboard?: ChannelInlineKeyboard): Promise<void> {
    await this.sendHtml(scopeId, html, keyboard);
  }

  async deleteMessage(scopeId: string, messageId: number): Promise<void> {
    void scopeId;
    void messageId;
  }

  async sendTypingInScope(scopeId: string): Promise<void> {
    void scopeId;
  }

  async clearInlineKeyboard(scopeId: string, messageId: number): Promise<void> {
    void scopeId;
    void messageId;
  }

  async sendDraft(scopeId: string, _draftId: number, text: string): Promise<void> {
    await this.sendPlain(scopeId, text);
  }
}
