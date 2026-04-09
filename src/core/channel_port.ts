/**
 * Opaque outbound message handle for the active UI surface (Telegram message id, Weixin id, etc.).
 */
export type ChannelMessageRef = number | string;

export type ChannelInlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

/**
 * Future: channel-agnostic outbound surface. Telegram uses {@link TelegramMessagingPort} today.
 */
export interface ChannelPort {
  sendPlain(scopeId: string, text: string, keyboard?: ChannelInlineKeyboard): Promise<ChannelMessageRef>;
  sendHtml(scopeId: string, text: string, keyboard?: ChannelInlineKeyboard): Promise<ChannelMessageRef>;
}
