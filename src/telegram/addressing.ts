import type { ParsedCommand } from '../controller/commands.js';

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

interface ResolveTelegramAddressingParams {
  text: string;
  attachmentsCount: number;
  entities: readonly TelegramMessageEntity[];
  command: ParsedCommand | null;
  botUsername: string | null;
  isDefaultTopic: boolean;
  replyToBot: boolean;
}

export type TelegramAddressingDecision =
  | { kind: 'ignore' }
  | { kind: 'command'; command: ParsedCommand }
  | { kind: 'prompt'; text: string };

interface DefaultScopeParams {
  chatType: string;
  allowedChatId: string | null;
  allowedTopicId: number | null;
  topicId: number | null;
}

export function resolveTelegramAddressing(params: ResolveTelegramAddressingParams): TelegramAddressingDecision {
  const botUsername = normalizeBotUsername(params.botUsername);
  if (params.command) {
    if (isCommandAddressedToThisBot(params.command, botUsername, params.isDefaultTopic)) {
      return { kind: 'command', command: params.command };
    }
    return { kind: 'ignore' };
  }

  const stripped = stripLeadingBotMention(params.text, params.entities, botUsername);
  const explicitMention = stripped !== null;
  const text = stripped ?? params.text;
  const normalizedText = text.trim();
  if (params.isDefaultTopic || params.replyToBot || explicitMention) {
    if (normalizedText || params.attachmentsCount > 0) {
      return { kind: 'prompt', text: normalizedText };
    }
  }
  return { kind: 'ignore' };
}

export function isDefaultTelegramScope(params: DefaultScopeParams): boolean {
  if (params.chatType === 'private') {
    return true;
  }
  if (params.allowedChatId === null) {
    return false;
  }
  if (params.allowedTopicId === null) {
    return true;
  }
  return params.topicId === params.allowedTopicId;
}

function normalizeBotUsername(botUsername: string | null): string | null {
  if (!botUsername) return null;
  return botUsername.trim().replace(/^@+/, '').toLowerCase() || null;
}

function isCommandAddressedToThisBot(
  command: ParsedCommand,
  botUsername: string | null,
  isDefaultTopic: boolean,
): boolean {
  if (command.targetBot === null) {
    return isDefaultTopic;
  }
  if (!botUsername) {
    return false;
  }
  return command.targetBot === botUsername;
}

function stripLeadingBotMention(
  text: string,
  entities: readonly TelegramMessageEntity[],
  botUsername: string | null,
): string | null {
  if (!botUsername) return null;
  const mentionEntity = entities.find(entity => entity.type === 'mention' && entity.offset === 0);
  if (!mentionEntity) return null;
  const mentionText = text.slice(mentionEntity.offset, mentionEntity.offset + mentionEntity.length);
  if (mentionText.toLowerCase() !== `@${botUsername}`) {
    return null;
  }
  return text.slice(mentionEntity.length).replace(/^[\s,:;-]+/, '');
}
