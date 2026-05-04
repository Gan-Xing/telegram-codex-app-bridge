import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';
import type { AppLocale, QueuedTurnInputRecord, ThreadBinding } from '../types.js';
import { resolveEngineCapabilities, type EngineProvider, type TurnInput } from '../engine/types.js';
import type { TurnRegistry } from './bridge_runtime.js';
import type { ActiveTurn } from './turn_state.js';
import type { InlineKeyboard, TelegramMessageService } from './telegram_message_service.js';
import { isTelegramMessageGone } from './telegram_message_service.js';
import { formatUserError } from './utils.js';

const DEFAULT_GUIDANCE_PROMPT_TIMEOUT_MS = 8_000;

interface GuidancePromptState {
  queueId: string;
  scopeId: string;
  messageId: number;
  expectedTurnId: string;
  timer: NodeJS.Timeout | null;
}

interface TurnGuidanceHost {
  logger: Logger;
  store: BridgeStore;
  turns: TurnRegistry;
  app: Pick<EngineProvider, 'capabilities' | 'steerTurn'>;
  messages: Pick<TelegramMessageService, 'sendMessage' | 'editMessage' | 'deleteMessage' | 'clearMessageButtons'>;
  localeForChat: (scopeId: string) => AppLocale;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
  syncGuidedPlanQueueDepth: (scopeId: string, queueDepth?: number) => Promise<void>;
  updateStatus: () => void;
  buildTurnInput: (
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    event: Pick<TelegramTextEvent, 'text' | 'attachments'>,
    locale: AppLocale,
  ) => Promise<TurnInput[]>;
  resolveActiveTurnBinding: (scopeId: string, active: Pick<ActiveTurn, 'threadId'>) => ThreadBinding;
  promptTimeoutMs?: number;
}

export class TurnGuidanceCoordinator {
  private readonly prompts = new Map<string, GuidancePromptState>();

  constructor(private readonly host: TurnGuidanceHost) {}

  private get capabilities() {
    return resolveEngineCapabilities(this.host.app.capabilities);
  }

  stop(): void {
    for (const prompt of this.prompts.values()) {
      if (prompt.timer) {
        clearTimeout(prompt.timer);
      }
    }
    this.prompts.clear();
  }

  async maybeOfferQueuedGuidancePrompt(
    record: QueuedTurnInputRecord,
    expectedTurnId: string,
    locale: AppLocale,
  ): Promise<void> {
    if (!this.capabilities.steerActiveTurn) {
      return;
    }
    if (this.getSteerBlockMessageKey(record.scopeId)) {
      return;
    }
    const text = renderQueuedGuidancePrompt(locale, record.sourceSummary);
    const keyboard = queuedGuidanceKeyboard(locale, record.queueId);
    let messageId = record.telegramMessageId;
    try {
      if (messageId !== null) {
        await this.host.messages.editMessage(record.scopeId, messageId, text, keyboard);
      } else {
        messageId = await this.host.messages.sendMessage(record.scopeId, text, keyboard);
        this.persistQueuedMessageId(record.queueId, messageId);
      }
    } catch (error) {
      if (messageId !== null) {
        try {
          messageId = await this.host.messages.sendMessage(record.scopeId, text, keyboard);
          this.persistQueuedMessageId(record.queueId, messageId);
        } catch (fallbackError) {
          this.host.logger.warn('guidance.prompt_send_failed', {
            scopeId: record.scopeId,
            queueId: record.queueId,
            error: String(fallbackError),
          });
          return;
        }
      } else {
        this.host.logger.warn('guidance.prompt_edit_failed', {
          scopeId: record.scopeId,
          queueId: record.queueId,
          error: String(error),
        });
        return;
      }
    }

    if (messageId === null) {
      return;
    }
    this.replacePrompt({
      queueId: record.queueId,
      scopeId: record.scopeId,
      messageId,
      expectedTurnId,
      timer: setTimeout(() => {
        void this.expirePrompt(record.queueId);
      }, this.host.promptTimeoutMs ?? DEFAULT_GUIDANCE_PROMPT_TIMEOUT_MS),
    });
  }

  async handleQueuedGuidanceCallback(
    event: TelegramCallbackEvent,
    queueId: string,
    action: 'steer' | 'keep',
    locale: AppLocale,
  ): Promise<void> {
    if (!this.capabilities.steerActiveTurn) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'guidance_not_supported'));
      return;
    }
    const record = this.host.store.getQueuedTurnInput(queueId);
    const prompt = this.prompts.get(queueId);
    if (!record || record.status !== 'queued' || !prompt || prompt.messageId !== event.messageId) {
      await this.dismissStalePrompt(event.scopeId, queueId, event.messageId);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'guidance_choice_expired'));
      return;
    }

    if (action === 'keep') {
      await this.closePrompt(queueId, prompt);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'guidance_kept_queued'));
      return;
    }

    const blockKey = this.getSteerBlockMessageKey(record.scopeId);
    if (blockKey) {
      await this.closePrompt(queueId, prompt);
      await this.host.answerCallback(event.callbackQueryId, t(locale, blockKey));
      return;
    }

    const active = this.host.turns.findByScope(record.scopeId);
    if (!active || active.turnId !== prompt.expectedTurnId || active.threadId !== record.threadId) {
      await this.closePrompt(queueId, prompt);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'guidance_target_finished'));
      return;
    }

    try {
      await this.host.app.steerTurn({
        threadId: active.threadId,
        turnId: active.turnId,
        input: record.input as TurnInput[],
        scopeId: record.scopeId,
      });
    } catch (error) {
      this.host.logger.warn('guidance.steer_failed', {
        scopeId: record.scopeId,
        queueId,
        turnId: active.turnId,
        error: String(error),
      });
      await this.closePrompt(queueId, prompt);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'guidance_insert_failed_short'));
      return;
    }

    this.host.store.removeQueuedTurnInput(queueId);
    await this.host.syncGuidedPlanQueueDepth(record.scopeId);
    this.host.updateStatus();
    await this.closePrompt(queueId, prompt);
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'guidance_inserted_short'));
  }

  async dismissQueuedGuidancePrompt(queueId: string): Promise<void> {
    const prompt = this.prompts.get(queueId);
    if (!prompt) {
      return;
    }
    await this.closePrompt(queueId, prompt);
  }

  async handleGuideCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    if (!this.capabilities.steerActiveTurn) {
      await this.host.messages.sendMessage(event.scopeId, t(locale, 'guidance_not_supported'));
      return;
    }
    const text = args.join(' ').trim();
    if (!text) {
      await this.host.messages.sendMessage(event.scopeId, t(locale, 'usage_guide'));
      return;
    }
    const active = this.host.turns.findByScope(event.scopeId);
    if (!active) {
      await this.host.messages.sendMessage(event.scopeId, t(locale, 'guidance_no_active_turn'));
      return;
    }
    const blockKey = this.getSteerBlockMessageKey(event.scopeId);
    if (blockKey) {
      await this.host.messages.sendMessage(event.scopeId, t(locale, blockKey));
      return;
    }
    const binding = this.host.resolveActiveTurnBinding(event.scopeId, active);
    const input = await this.host.buildTurnInput(binding, { text, attachments: event.attachments }, locale);
    try {
      await this.host.app.steerTurn({
        threadId: active.threadId,
        turnId: active.turnId,
        input,
        scopeId: event.scopeId,
      });
    } catch (error) {
      await this.host.messages.sendMessage(
        event.scopeId,
        t(locale, 'guidance_insert_failed_message', { error: formatUserError(error) }),
      );
      return;
    }
    await this.host.messages.sendMessage(event.scopeId, t(locale, 'guidance_inserted_message'));
  }

  private async expirePrompt(queueId: string): Promise<void> {
    const prompt = this.prompts.get(queueId);
    if (!prompt) {
      return;
    }
    await this.closePrompt(queueId, prompt);
  }

  private async dismissStalePrompt(scopeId: string, queueId: string, messageId: number): Promise<void> {
    this.clearPromptTimer(queueId);
    try {
      await this.host.messages.deleteMessage(scopeId, messageId);
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        await this.host.messages.clearMessageButtons(scopeId, messageId).catch(() => undefined);
      }
    }
    const record = this.host.store.getQueuedTurnInput(queueId);
    if (record) {
      this.persistQueuedMessageId(queueId, null);
    }
  }

  private async closePrompt(queueId: string, prompt: GuidancePromptState): Promise<void> {
    this.clearPromptTimer(queueId);
    try {
      await this.host.messages.deleteMessage(prompt.scopeId, prompt.messageId);
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        await this.host.messages.clearMessageButtons(prompt.scopeId, prompt.messageId).catch(() => undefined);
      }
    }
    if (this.host.store.getQueuedTurnInput(queueId)) {
      this.persistQueuedMessageId(queueId, null);
    }
  }

  private replacePrompt(prompt: GuidancePromptState): void {
    const existing = this.prompts.get(prompt.queueId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    this.prompts.set(prompt.queueId, prompt);
  }

  private clearPromptTimer(queueId: string): void {
    const existing = this.prompts.get(queueId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    this.prompts.delete(queueId);
  }

  private persistQueuedMessageId(queueId: string, messageId: number | null): void {
    const current = this.host.store.getQueuedTurnInput(queueId);
    if (!current) {
      return;
    }
    this.host.store.saveQueuedTurnInput({
      ...current,
      telegramMessageId: messageId,
      updatedAt: Date.now(),
    });
  }

  private getSteerBlockMessageKey(scopeId: string):
    | 'guidance_blocked_pending_input'
    | 'guidance_blocked_pending_approval'
    | 'guidance_blocked_plan_pending'
    | 'guidance_blocked_review_turn'
    | null {
    const active = this.host.turns.findByScope(scopeId);
    if (active?.turnKind === 'review') {
      return 'guidance_blocked_review_turn';
    }
    if (this.host.store.getPendingUserInputForChat(scopeId)) {
      return 'guidance_blocked_pending_input';
    }
    if (this.host.store.listPendingApprovals(scopeId).length > 0) {
      return 'guidance_blocked_pending_approval';
    }
    if (this.host.store.listOpenPlanSessions(scopeId).some((session) =>
      session.state === 'awaiting_plan_confirmation' || session.state === 'recovery_required')) {
      return 'guidance_blocked_plan_pending';
    }
    return null;
  }
}

export function renderQueuedGuidancePrompt(locale: AppLocale, summary: string): string {
  return [
    t(locale, 'guidance_prompt_queued'),
    t(locale, 'guidance_prompt_message', { value: summary }),
    t(locale, 'guidance_prompt_choose'),
  ].join('\n');
}

function queuedGuidanceKeyboard(locale: AppLocale, queueId: string): InlineKeyboard {
  return [[
    { text: t(locale, 'button_guidance_insert'), callback_data: `guidance:${queueId}:steer` },
    { text: t(locale, 'button_guidance_keep_queue'), callback_data: `guidance:${queueId}:keep` },
  ]];
}
