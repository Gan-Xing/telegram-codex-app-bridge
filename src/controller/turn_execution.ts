import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';
import type { AppLocale, PendingApprovalRecord, ThreadBinding } from '../types.js';
import type { EngineProvider, ReviewDelivery, ReviewTarget, TurnInput } from '../engine/types.js';
import type { TurnRegistry } from './bridge_runtime.js';
import type { ActiveTurn } from './turn_state.js';
import { PLAN_MODE_DRAFT_ONLY_DEVELOPER_INSTRUCTIONS, type GuidedPlanCoordinator } from './guided_plan.js';
import type { TurnRenderingCoordinator } from './turn_rendering.js';
import { ensureTurnSegment } from './turn_rendering.js';
import type { TurnLifecycleCoordinator } from './turn_lifecycle.js';
import type { TelegramMessageService } from './telegram_message_service.js';
import type { StatusPreviewCoordinator } from './status_preview.js';
import { sanitizeAssistantText } from '../assistant_text.js';
import { formatUserError } from './utils.js';

interface TurnExecutionHost {
  logger: Logger;
  store: BridgeStore;
  app: Pick<EngineProvider, 'interruptTurn' | 'respond'>;
  turns: TurnRegistry;
  localeForChat: (scopeId: string) => AppLocale;
  shouldRequirePlanConfirmation: (scopeId: string) => boolean;
  messages: TelegramMessageService;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
  handleAsyncError: (source: string, error: unknown, scopeId?: string) => Promise<void>;
  guidedPlans: Pick<GuidedPlanCoordinator, 'createSession' | 'syncTurnPlan' | 'queuePlanRender'>;
  turnRendering: Pick<
    TurnRenderingCoordinator,
    'queueRender' | 'noteToolCommandStart' | 'noteToolCommandEnd' | 'promoteReadyToolBatch' | 'findStreamingSegment'
  >;
  turnLifecycle: Pick<TurnLifecycleCoordinator, 'registerTurn' | 'handleTurnCompleted'>;
  statusPreview: Pick<StatusPreviewCoordinator, 'cleanupStaleInterruptButton'>;
  startTurnWithRecovery: (
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    input: TurnInput[],
    options?: {
      developerInstructions?: string | null;
      accessOverride?: { approvalPolicy: string; sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' };
      collaborationModeOverride?: 'plan' | null;
    },
  ) => Promise<{ threadId: string; turnId: string }>;
  startReviewWithRecovery: (
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    options: {
      target: ReviewTarget;
      delivery?: ReviewDelivery | null;
    },
  ) => Promise<{ threadId: string; turnId: string }>;
  createBinding: (scopeId: string, requestedCwd: string | null) => Promise<ThreadBinding>;
  ensureThreadReady: (scopeId: string, binding: ThreadBinding) => Promise<ThreadBinding>;
  noteTurnFailure: (message: string) => void;
  onStatusChanged: () => void;
}

export class TurnExecutionCoordinator {
  constructor(private readonly host: TurnExecutionHost) {}

  async startIncomingTurn(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    binding: ThreadBinding,
    input: TurnInput[],
    options: { queuedInputId?: string | null } = {},
  ): Promise<void> {
    const requiresPlanConfirmation = this.host.shouldRequirePlanConfirmation(scopeId);
    const turnState = await this.host.startTurnWithRecovery(
      scopeId,
      binding,
      input,
      requiresPlanConfirmation
        ? {
            developerInstructions: PLAN_MODE_DRAFT_ONLY_DEVELOPER_INSTRUCTIONS,
            accessOverride: {
              approvalPolicy: 'on-request',
              sandboxMode: 'read-only',
            },
          }
        : {},
    );
    let guidedPlanSessionId: string | null = null;
    if (requiresPlanConfirmation) {
      guidedPlanSessionId = this.host.guidedPlans.createSession(scopeId, turnState.threadId, turnState.turnId);
    }
    this.launchRegisteredTurn(
      scopeId,
      chatId,
      chatType,
      topicId,
      turnState.threadId,
      turnState.turnId,
      0,
      {
        guidedPlanSessionId,
        guidedPlanDraftOnly: requiresPlanConfirmation,
        queuedInputId: options.queuedInputId ?? null,
      },
    );
  }

  async handleReviewCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const parsed = parseReviewCommandArgs(args);
    if (!parsed) {
      await this.host.messages.sendMessage(event.scopeId, t(locale, 'usage_review'));
      return;
    }
    if (this.host.turns.findByScope(event.scopeId)) {
      await this.host.messages.sendMessage(event.scopeId, t(locale, 'another_turn_running'));
      return;
    }
    const existingBinding = this.host.store.getBinding(event.scopeId);
    const binding = existingBinding
      ? await this.host.ensureThreadReady(event.scopeId, existingBinding)
      : await this.host.createBinding(event.scopeId, null);
    await this.host.messages.sendTyping(event.scopeId);
    const review = await this.host.startReviewWithRecovery(event.scopeId, binding, parsed);
    this.launchRegisteredTurn(
      event.scopeId,
      event.chatId,
      event.chatType,
      event.topicId,
      review.threadId,
      review.turnId,
      0,
      { turnKind: 'review' },
    );
  }

  launchRegisteredTurn(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    threadId: string,
    turnId: string,
    previewMessageId: number,
    options: {
      guidedPlanSessionId?: string | null;
      guidedPlanDraftOnly?: boolean;
      queuedInputId?: string | null;
      profileId?: string | null;
      turnKind?: 'default' | 'review';
    } = {},
  ): void {
    void this.host.turnLifecycle.registerTurn(
      scopeId,
      chatId,
      chatType,
      topicId,
      threadId,
      turnId,
      previewMessageId,
      {
        ...options,
        profileId: options.profileId ?? this.host.store.getActiveProviderProfile(scopeId),
      },
    ).catch((error) => {
      void this.host.handleAsyncError(options.queuedInputId ? 'queue.start' : 'telegram.turn_start', error, scopeId);
    });
  }

  async handleTurnActivityEvent(activity: any): Promise<void> {
    const active = this.host.turns.get(activity.turnId);
    if (!active) {
      return;
    }

    switch (activity.kind) {
      case 'agent_message_started': {
        this.host.turnRendering.promoteReadyToolBatch(active);
        ensureTurnSegment(active, activity.itemId, activity.phase, activity.outputKind);
        await this.host.turnRendering.queueRender(active, { forceStatus: true });
        return;
      }
      case 'agent_message_delta': {
        const segment = ensureTurnSegment(active, activity.itemId, undefined, activity.outputKind);
        segment.rawText += activity.delta;
        segment.text = sanitizeAssistantText(segment.rawText) ?? '';
        active.buffer = collectVisibleFinalOutput(active);
        await this.host.turnRendering.queueRender(active);
        return;
      }
      case 'agent_message_completed': {
        const segment = ensureTurnSegment(active, activity.itemId, activity.phase, activity.outputKind);
        if (activity.text !== null) {
          segment.rawText = activity.text;
          segment.text = sanitizeAssistantText(activity.text) ?? '';
          active.buffer = collectVisibleFinalOutput(active);
          if (activity.outputKind === 'final_answer') {
            active.finalText = segment.text || active.buffer || t(this.host.localeForChat(active.scopeId), 'completed');
          }
        }
        segment.completed = true;
        await this.host.turnRendering.queueRender(active, { forceStream: true, forceStatus: true });
        return;
      }
      case 'reasoning_started': {
        this.host.turnRendering.promoteReadyToolBatch(active);
        active.reasoningActiveCount += 1;
        await this.host.turnRendering.queueRender(active, { forceStatus: true });
        return;
      }
      case 'reasoning_completed': {
        active.reasoningActiveCount = Math.max(0, active.reasoningActiveCount - 1);
        await this.host.turnRendering.queueRender(active, { forceStatus: true });
        return;
      }
      case 'tool_started': {
        this.host.turnRendering.noteToolCommandStart(active, activity.exec);
        await this.host.turnRendering.queueRender(active, { forceStatus: true });
        return;
      }
      case 'tool_completed': {
        this.host.turnRendering.noteToolCommandEnd(active, activity.exec);
        await this.host.turnRendering.queueRender(active, { forceStatus: true });
        return;
      }
      case 'turn_completed': {
        active.completionState = activity.state;
        active.completionStatusText = activity.statusText ?? null;
        active.completionErrorText = activity.errorText ?? null;
        if (activity.state !== 'completed' && activity.state !== 'interrupted') {
          this.host.noteTurnFailure(activity.errorText ?? activity.statusText ?? activity.state);
        }
        this.host.turnRendering.promoteReadyToolBatch(active);
        await this.host.turnLifecycle.handleTurnCompleted(active);
      }
    }
  }

  async rejectDraftOnlyApprovalRequestIfNeeded(serverRequestId: string | number, params: any): Promise<boolean> {
    const turnId = typeof params?.turnId === 'string' ? params.turnId : String(params?.turnId || '');
    if (!turnId) {
      return false;
    }
    const active = this.host.turns.get(turnId);
    if (!active?.guidedPlanDraftOnly) {
      return false;
    }
    active.guidedPlanExecutionBlocked = true;
    await this.host.app.respond(serverRequestId, { decision: 'decline' }, active.scopeId);
    await this.host.messages.sendMessage(active.scopeId, t(this.host.localeForChat(active.scopeId), 'plan_draft_execution_blocked'));
    if (!active.interruptRequested) {
      try {
        const result = await this.requestInterrupt(active);
        if (result === 'stale') {
          await this.retireStaleTurn(active, new Error('no active turn to interrupt'));
        }
      } catch (error) {
        this.host.logger.warn('guided_plan.draft_interrupt_failed', {
          turnId: active.turnId,
          error: String(error),
        });
      }
    }
    return true;
  }

  async handleTurnInterruptCallback(event: TelegramCallbackEvent, turnId: string, locale: AppLocale): Promise<void> {
    const active = this.host.turns.get(turnId);
    if (!active || active.scopeId !== event.scopeId) {
      await this.host.statusPreview.cleanupStaleInterruptButton(event.scopeId, event.messageId, locale);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'turn_already_finished'));
      return;
    }
    if (active.interruptRequested) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'interrupt_already_requested'));
      return;
    }
    active.interruptRequested = true;
    try {
      const result = await this.requestInterrupt(active);
      if (result === 'stale') {
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'stale_turn_retired'));
        await this.retireStaleTurn(active, new Error('no active turn to interrupt'));
      } else {
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'interrupt_requested'));
      }
    } catch (error) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'interrupt_failed', { error: formatUserError(error) }));
    }
  }

  async handleInterruptCommand(scopeId: string, locale: AppLocale): Promise<boolean> {
    const active = this.host.turns.findByScope(scopeId);
    if (!active) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'no_active_turn'));
      return false;
    }
    const result = await this.requestInterrupt(active);
    if (result === 'stale') {
      await this.host.messages.sendMessage(scopeId, t(locale, 'stale_turn_retired'));
      await this.retireStaleTurn(active, new Error('no active turn to interrupt'));
      return true;
    }
    await this.host.messages.sendMessage(scopeId, t(locale, 'interrupt_requested_for', { turnId: active.turnId }));
    return true;
  }

  async notePendingApprovalStatus(threadId: string, kind: PendingApprovalRecord['kind']): Promise<void> {
    const active = this.host.turns.findByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingApprovalKinds.add(kind);
    await this.host.turnRendering.queueRender(active, { forceStatus: true });
  }

  async clearPendingApprovalStatus(threadId: string, kind: PendingApprovalRecord['kind']): Promise<void> {
    const active = this.host.turns.findByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingApprovalKinds.delete(kind);
    await this.host.turnRendering.queueRender(active, { forceStatus: true });
  }

  async notePendingUserInputStatus(threadId: string, localId: string): Promise<void> {
    const active = this.host.turns.findByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingUserInputId = localId;
    await this.host.turnRendering.queueRender(active, { forceStatus: true });
  }

  async clearPendingUserInputStatus(threadId: string, localId: string): Promise<void> {
    const active = this.host.turns.findByThreadId(threadId);
    if (!active || active.pendingUserInputId !== localId) {
      return;
    }
    active.pendingUserInputId = null;
    await this.host.turnRendering.queueRender(active, { forceStatus: true });
  }

  async syncTurnPlan(active: ActiveTurn, params: any): Promise<void> {
    await this.host.guidedPlans.syncTurnPlan(active, params);
  }

  findStreamingSegment(active: ActiveTurn) {
    return this.host.turnRendering.findStreamingSegment(active);
  }

  private async requestInterrupt(active: ActiveTurn): Promise<'requested' | 'stale'> {
    active.interruptRequested = true;
    try {
      await this.host.app.interruptTurn(active.threadId, active.turnId, active.scopeId);
      await this.host.turnRendering.queueRender(active, { forceStatus: true, forceStream: true });
      return 'requested';
    } catch (error) {
      if (isNoActiveTurnToInterruptError(error)) {
        return 'stale';
      }
      active.interruptRequested = false;
      throw error;
    }
  }

  private async retireStaleTurn(active: ActiveTurn, error: unknown): Promise<void> {
    if (!this.host.turns.has(active.turnId)) {
      return;
    }
    active.interruptRequested = true;
    active.completionState = 'interrupted';
    active.completionStatusText = 'stale upstream turn';
    active.completionErrorText = formatUserError(error);
    this.host.logger.warn('turn.stale_interrupt_retired', {
      scopeId: active.scopeId,
      threadId: active.threadId,
      turnId: active.turnId,
      error: formatUserError(error),
    });
    await this.host.turnLifecycle.handleTurnCompleted(active);
  }
}

function isNoActiveTurnToInterruptError(error: unknown): boolean {
  return /no active turn to interrupt/i.test(formatUserError(error));
}

function parseReviewCommandArgs(args: string[]): {
  target: ReviewTarget;
  delivery?: ReviewDelivery | null;
} | null {
  const parts = args.map((value) => value.trim()).filter(Boolean);
  let delivery: ReviewDelivery | null = null;
  const last = parts.at(-1)?.toLowerCase() ?? null;
  if (last === 'inline' || last === 'detached') {
    delivery = last;
    parts.pop();
  }
  if (parts.length === 0) {
    return { target: { type: 'uncommittedChanges' }, delivery };
  }
  const mode = parts[0]!.toLowerCase();
  if (mode === 'changes' || mode === 'uncommitted' || mode === 'working') {
    return parts.length === 1 ? { target: { type: 'uncommittedChanges' }, delivery } : null;
  }
  if (mode === 'base' || mode === 'branch') {
    const branch = parts.slice(1).join(' ').trim();
    return branch ? { target: { type: 'baseBranch', branch }, delivery } : null;
  }
  if (mode === 'commit') {
    const sha = parts[1]?.trim() ?? '';
    const title = parts.slice(2).join(' ').trim();
    return sha ? { target: { type: 'commit', sha, title: title || null }, delivery } : null;
  }
  if (mode === 'custom') {
    const instructions = parts.slice(1).join(' ').trim();
    return instructions ? { target: { type: 'custom', instructions }, delivery } : null;
  }
  return null;
}

function collectVisibleFinalOutput(active: { segments: Array<{ outputKind: string; text: string }> }): string {
  return active.segments
    .filter((segment) => segment.outputKind === 'final_answer')
    .map((segment) => segment.text)
    .join('');
}
