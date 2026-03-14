import crypto from 'node:crypto';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import {
  DEFAULT_GUIDED_PLAN_PREFERENCES,
  type AppLocale,
  type GuidedPlanSession,
  type PlanSnapshotStep,
  type SandboxModeValue,
  type ThreadBinding,
} from '../types.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import {
  PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  type TurnInput,
} from '../codex_app/client.js';

export type PlanSessionAction = 'confirm' | 'revise' | 'cancel';
export type PlanRecoveryAction = 'continue' | 'show' | 'cancel';

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

export interface GuidedPlanTurnState {
  scopeId: string;
  threadId: string;
  turnId: string;
  interruptRequested: boolean;
  planMessageId: number | null;
  planText: string | null;
  planExplanation: string | null;
  planSteps: PlanSnapshotStep[];
  planDraftText: string | null;
  planLastRenderedAt: number;
  planRenderRequested: boolean;
  forcePlanRender: boolean;
  planRenderTask: Promise<void> | null;
  guidedPlanSessionId: string | null;
  guidedPlanDraftOnly: boolean;
  guidedPlanExecutionBlocked: boolean;
}

interface StartTurnOptions {
  developerInstructions?: string | null;
  accessOverride?: { approvalPolicy: string; sandboxMode: SandboxModeValue };
  collaborationModeOverride?: 'plan' | null;
}

interface GuidedPlanHost {
  store: BridgeStore;
  logger: Logger;
  localeForChat: (scopeId: string) => AppLocale;
  sendMessage: (scopeId: string, text: string, inlineKeyboard?: InlineKeyboard) => Promise<number>;
  sendHtmlMessage: (scopeId: string, text: string, inlineKeyboard?: InlineKeyboard) => Promise<number>;
  editHtmlMessage: (scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard) => Promise<void>;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
  sendTyping: (scopeId: string) => Promise<void>;
  updateStatus: () => void;
  hasActiveTurnInScope: (scopeId: string) => boolean;
  hasActiveTurn: (turnId: string) => boolean;
  refreshActiveTurnStatus: (scopeId: string) => Promise<void>;
  resolvePlanSessionBinding: (scopeId: string, threadId: string) => Promise<ThreadBinding>;
  startTurnWithRecovery: (
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    input: TurnInput[],
    options?: StartTurnOptions,
  ) => Promise<{ threadId: string; turnId: string }>;
  launchRegisteredTurn: (
    scopeId: string,
    chatId: string,
    topicId: number | null,
    threadId: string,
    turnId: string,
    options: { guidedPlanSessionId?: string | null; guidedPlanDraftOnly?: boolean },
    errorSource: string,
  ) => void;
  maybeStartQueuedTurn: (scopeId: string) => Promise<boolean>;
}

export const PLAN_MODE_DRAFT_ONLY_DEVELOPER_INSTRUCTIONS = [
  PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  'You are in the planning-only phase of plan mode.',
  'Produce or refine the plan, but do not execute commands, edit files, or apply changes yet.',
  'If you need clarification, ask focused requestUserInput questions.',
  'Once the plan is ready, stop and wait for explicit user confirmation before execution.',
].join('\n\n');

const PLAN_MODE_EXECUTION_CONFIRMATION_PROMPT = [
  PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  'The user confirmed the latest plan.',
  'Execute it now.',
  'Keep asking focused requestUserInput questions if more guidance is needed.',
].join('\n\n');

const PLAN_MODE_REVISE_PROMPT = [
  PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  'Revise the latest plan before executing anything.',
  'Produce the updated plan only, then stop and wait for confirmation.',
].join('\n\n');

const PLAN_MODE_RECOVERY_EXECUTION_PROMPT = [
  PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  'The bridge restarted after the user had already confirmed a plan.',
  'Re-check the latest repository state, then continue executing the confirmed plan.',
].join('\n\n');

const PLAN_MODE_RECOVERY_DRAFT_PROMPT = [
  PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  'The bridge restarted before the plan flow was resolved.',
  'Rebuild or revise the latest plan only, then stop and wait for confirmation.',
].join('\n\n');

const PLAN_RENDER_DEBOUNCE_MS = 250;

export class GuidedPlanCoordinator {
  constructor(private readonly host: GuidedPlanHost) {}

  getAwaitingPlanConfirmationSession(scopeId: string): GuidedPlanSession | null {
    return this.host.store.listOpenPlanSessions(scopeId)
      .find((session) => session.state === 'awaiting_plan_confirmation') ?? null;
  }

  createSession(scopeId: string, threadId: string, sourceTurnId: string): string {
    const now = Date.now();
    const sessionId = crypto.randomBytes(8).toString('hex');
    this.host.store.savePlanSession({
      sessionId,
      chatId: scopeId,
      threadId,
      sourceTurnId,
      executionTurnId: null,
      state: 'drafting_plan',
      confirmationRequired: true,
      confirmedPlanVersion: null,
      latestPlanVersion: null,
      currentPromptId: null,
      currentApprovalId: null,
      queueDepth: 0,
      lastPlanMessageId: null,
      lastPromptMessageId: null,
      lastApprovalMessageId: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    });
    return sessionId;
  }

  async recoverSessions(): Promise<void> {
    for (const session of this.host.store.listOpenPlanSessions()) {
      const locale = this.host.localeForChat(session.chatId);
      if (session.state === 'awaiting_plan_confirmation') {
        const rendered = renderPlanConfirmationMessage(locale, session);
        const messageId = await this.upsertPlanConfirmationPrompt(session, rendered);
        this.updateSession(session.sessionId, { lastPromptMessageId: messageId });
        continue;
      }
      const nextSession = session.state === 'recovery_required'
        ? session
        : this.updateSession(session.sessionId, {
            state: 'recovery_required',
            currentPromptId: crypto.randomBytes(6).toString('hex'),
          });
      if (!nextSession) {
        continue;
      }
      const latestSnapshot = this.host.store.listPlanSnapshots(nextSession.sessionId).at(-1) ?? null;
      const rendered = renderPlanRecoveryMessage(locale, nextSession, latestSnapshot);
      const messageId = await this.upsertPlanConfirmationPrompt(nextSession, rendered);
      this.updateSession(nextSession.sessionId, { lastPromptMessageId: messageId });
    }
  }

  async handlePlanRecoveryCallback(
    event: TelegramCallbackEvent,
    sessionId: string,
    action: PlanRecoveryAction,
    locale: AppLocale,
  ): Promise<void> {
    const session = this.host.store.getPlanSession(sessionId);
    if (!session) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_resolved'));
      return;
    }
    if (session.chatId !== event.scopeId || (session.lastPromptMessageId !== null && session.lastPromptMessageId !== event.messageId)) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_confirmation_mismatch'));
      return;
    }
    if (session.state !== 'recovery_required') {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_resolved'));
      return;
    }
    if (action === 'show') {
      const latestSnapshot = this.host.store.listPlanSnapshots(sessionId).at(-1) ?? null;
      if (!latestSnapshot) {
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_no_snapshot'));
        return;
      }
      await this.host.sendHtmlMessage(event.scopeId, renderRecoveredPlanSnapshotMessage(locale, session, latestSnapshot));
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_showing_snapshot'));
      return;
    }
    if (action === 'cancel') {
      const cancelled = this.updateSession(sessionId, {
        state: 'cancelled',
        currentPromptId: null,
        resolvedAt: Date.now(),
      });
      if (cancelled && cancelled.lastPromptMessageId !== null) {
        await this.host.editHtmlMessage(
          cancelled.chatId,
          cancelled.lastPromptMessageId,
          renderResolvedPlanRecoveryMessage(locale, cancelled, action),
          [],
        );
      }
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_cancelled'));
      await this.host.maybeStartQueuedTurn(event.scopeId);
      return;
    }
    if (this.host.hasActiveTurnInScope(event.scopeId)) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
      return;
    }
    const binding = await this.host.resolvePlanSessionBinding(event.scopeId, session.threadId);
    const continuingConfirmedPlan = session.confirmedPlanVersion !== null;
    await this.host.sendTyping(event.scopeId);
    const turnState = await this.host.startTurnWithRecovery(
      event.scopeId,
      binding,
      this.buildPlanTurnInput(continuingConfirmedPlan ? PLAN_MODE_RECOVERY_EXECUTION_PROMPT : PLAN_MODE_RECOVERY_DRAFT_PROMPT),
      continuingConfirmedPlan
        ? {
            developerInstructions: PLAN_MODE_RECOVERY_EXECUTION_PROMPT,
            collaborationModeOverride: 'plan',
          }
        : {
            developerInstructions: PLAN_MODE_RECOVERY_DRAFT_PROMPT,
            accessOverride: {
              approvalPolicy: 'on-request',
              sandboxMode: 'read-only',
            },
            collaborationModeOverride: 'plan',
          },
    );
    const nextSession = this.updateSession(sessionId, {
      threadId: turnState.threadId,
      sourceTurnId: continuingConfirmedPlan ? session.sourceTurnId : turnState.turnId,
      executionTurnId: continuingConfirmedPlan ? turnState.turnId : null,
      state: continuingConfirmedPlan ? 'executing_confirmed_plan' : 'drafting_plan',
      currentPromptId: null,
      resolvedAt: null,
    });
    if (session.lastPromptMessageId !== null && nextSession) {
      await this.host.editHtmlMessage(
        session.chatId,
        session.lastPromptMessageId,
        renderResolvedPlanRecoveryMessage(locale, nextSession, action),
        [],
      );
    }
    this.host.launchRegisteredTurn(
      event.scopeId,
      event.chatId,
      event.topicId,
      turnState.threadId,
      turnState.turnId,
      {
        guidedPlanSessionId: sessionId,
        guidedPlanDraftOnly: !continuingConfirmedPlan,
      },
      'plan.recovery_start',
    );
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_continuing'));
  }

  async handlePlanSessionCallback(
    event: TelegramCallbackEvent,
    sessionId: string,
    action: PlanSessionAction,
    locale: AppLocale,
  ): Promise<void> {
    const session = this.host.store.getPlanSession(sessionId);
    if (!session) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_confirmation_resolved'));
      return;
    }
    if (session.chatId !== event.scopeId || (session.lastPromptMessageId !== null && session.lastPromptMessageId !== event.messageId)) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_confirmation_mismatch'));
      return;
    }
    if (session.resolvedAt !== null || session.state === 'cancelled' || session.state === 'completed' || session.state === 'interrupted') {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_confirmation_resolved'));
      return;
    }
    if (session.state !== 'awaiting_plan_confirmation') {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_action_unavailable'));
      return;
    }
    if (this.host.hasActiveTurnInScope(event.scopeId)) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
      return;
    }
    if (action === 'cancel') {
      const cancelled = this.updateSession(sessionId, {
        state: 'cancelled',
        currentPromptId: null,
        resolvedAt: Date.now(),
      });
      if (cancelled && cancelled.lastPromptMessageId !== null) {
        await this.host.editHtmlMessage(
          cancelled.chatId,
          cancelled.lastPromptMessageId,
          renderResolvedPlanConfirmationMessage(locale, cancelled, action),
          [],
        );
      }
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_action_started_cancel'));
      this.host.updateStatus();
      await this.host.maybeStartQueuedTurn(event.scopeId);
      return;
    }
    if (action === 'confirm' && !canConfirmPlanSession(session)) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'plan_action_unavailable'));
      return;
    }

    await this.host.sendTyping(event.scopeId);
    const binding = await this.host.resolvePlanSessionBinding(event.scopeId, session.threadId);
    const turnState = await this.host.startTurnWithRecovery(
      event.scopeId,
      binding,
      this.buildPlanTurnInput(action === 'confirm' ? PLAN_MODE_EXECUTION_CONFIRMATION_PROMPT : PLAN_MODE_REVISE_PROMPT),
      action === 'revise'
        ? {
            developerInstructions: PLAN_MODE_REVISE_PROMPT,
            accessOverride: {
              approvalPolicy: 'on-request',
              sandboxMode: 'read-only',
            },
            collaborationModeOverride: 'plan',
          }
        : {
            developerInstructions: PLAN_MODE_EXECUTION_CONFIRMATION_PROMPT,
            collaborationModeOverride: 'plan',
          },
    );
    const nextSession = this.updateSession(sessionId, {
      threadId: turnState.threadId,
      sourceTurnId: action === 'revise' ? turnState.turnId : session.sourceTurnId,
      executionTurnId: action === 'confirm' ? turnState.turnId : null,
      state: action === 'confirm' ? 'executing_confirmed_plan' : 'drafting_plan',
      confirmedPlanVersion: action === 'confirm'
        ? session.latestPlanVersion
        : session.confirmedPlanVersion,
      currentPromptId: null,
      lastPromptMessageId: action === 'revise' ? null : session.lastPromptMessageId,
      resolvedAt: null,
    });
    if (session.lastPromptMessageId !== null && nextSession) {
      await this.host.editHtmlMessage(
        session.chatId,
        session.lastPromptMessageId,
        renderResolvedPlanConfirmationMessage(locale, nextSession, action),
        [],
      );
    }
    this.host.launchRegisteredTurn(
      event.scopeId,
      event.chatId,
      event.topicId,
      turnState.threadId,
      turnState.turnId,
      {
        guidedPlanSessionId: sessionId,
        guidedPlanDraftOnly: action === 'revise',
      },
      'plan.session_start',
    );
    await this.host.answerCallback(
      event.callbackQueryId,
      t(locale, action === 'confirm' ? 'plan_action_started_confirm' : 'plan_action_started_revise'),
    );
  }

  async syncQueueDepth(scopeId: string, queueDepth = this.host.store.countQueuedTurnInputs(scopeId)): Promise<void> {
    for (const session of this.host.store.listOpenPlanSessions(scopeId)) {
      if (session.queueDepth === queueDepth) {
        continue;
      }
      this.updateSession(session.sessionId, { queueDepth });
    }
    await this.host.refreshActiveTurnStatus(scopeId);
    this.host.updateStatus();
  }

  async syncTurnPlan(active: GuidedPlanTurnState, params: any): Promise<void> {
    const explanation = typeof params?.explanation === 'string' && params.explanation.trim()
      ? params.explanation.trim()
      : null;
    const steps = normalizePlanSteps(Array.isArray(params?.plan) ? params.plan : []);
    const previousExplanation = active.planExplanation;
    const previousSteps = active.planSteps;
    active.planExplanation = explanation;
    active.planSteps = steps;
    active.planDraftText = null;
    const session = active.guidedPlanSessionId ? this.host.store.getPlanSession(active.guidedPlanSessionId) : null;
    let version = session?.latestPlanVersion ?? null;
    const latestSnapshot = !session || session.latestPlanVersion === null
      ? null
      : this.host.store.listPlanSnapshots(session.sessionId).at(-1) ?? null;
    const planChanged = latestSnapshot
      ? latestSnapshot.explanation !== explanation || !planStepsEqual(latestSnapshot.steps, steps)
      : previousExplanation !== explanation || !planStepsEqual(previousSteps, steps);
    if (session && planChanged) {
      version = (session.latestPlanVersion ?? 0) + 1;
      if (this.host.store.getChatSettings(active.scopeId)?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory) {
        this.host.store.savePlanSnapshot({
          sessionId: session.sessionId,
          version,
          sourceEvent: 'turn/plan/updated',
          explanation,
          steps,
          createdAt: Date.now(),
        });
      }
    }
    if (session) {
      this.updateSession(session.sessionId, {
        latestPlanVersion: version ?? session.latestPlanVersion,
      });
    }
    await this.queuePlanRender(active);
  }

  async finalizeTurn(active: GuidedPlanTurnState): Promise<void> {
    if (!active.guidedPlanSessionId) {
      return;
    }
    const session = this.host.store.getPlanSession(active.guidedPlanSessionId);
    if (!session) {
      return;
    }
    if (session.resolvedAt !== null || session.state === 'cancelled') {
      this.host.updateStatus();
      return;
    }
    const currentMode = this.host.store.getChatSettings(active.scopeId)?.collaborationMode ?? null;
    if (active.guidedPlanDraftOnly && currentMode !== 'plan') {
      this.updateSession(session.sessionId, {
        state: 'cancelled',
        currentPromptId: null,
        resolvedAt: Date.now(),
      });
      this.host.updateStatus();
      return;
    }
    if (active.guidedPlanDraftOnly) {
      await this.finalizeDraftTurn(active, session);
      return;
    }
    const terminalState = active.interruptRequested ? 'interrupted' : 'completed';
    this.updateSession(session.sessionId, {
      state: terminalState,
      currentPromptId: null,
      executionTurnId: active.turnId,
      resolvedAt: Date.now(),
    });
    this.host.updateStatus();
  }

  async queuePlanRender(active: GuidedPlanTurnState, force = false): Promise<void> {
    active.planRenderRequested = true;
    active.forcePlanRender = active.forcePlanRender || force;
    if (force) {
      await this.renderPlanCard(active);
      active.planRenderRequested = false;
      active.forcePlanRender = false;
      return;
    }
    if (active.planRenderTask) {
      await active.planRenderTask;
      return;
    }
    active.planRenderTask = (async () => {
      while (active.planRenderRequested) {
        const forceRender = active.forcePlanRender;
        active.planRenderRequested = false;
        active.forcePlanRender = false;
        const debounceMs = forceRender
          ? 0
          : Math.max(0, PLAN_RENDER_DEBOUNCE_MS - (Date.now() - active.planLastRenderedAt));
        if (debounceMs > 0) {
          await delay(debounceMs);
        }
        if (!this.host.hasActiveTurn(active.turnId)) {
          return;
        }
        await this.renderPlanCard(active);
      }
    })().finally(() => {
      active.planRenderTask = null;
    });
    await active.planRenderTask;
  }

  async renderPlanCard(active: GuidedPlanTurnState): Promise<void> {
    const session = active.guidedPlanSessionId ? this.host.store.getPlanSession(active.guidedPlanSessionId) : null;
    const hasStructuredPlan = active.planSteps.length > 0 || Boolean(active.planExplanation);
    const hasDraftText = Boolean(active.planDraftText?.trim());
    if (!hasStructuredPlan && !hasDraftText) {
      return;
    }
    const locale = this.host.localeForChat(active.scopeId);
    const html = renderTurnPlanMessage(locale, active.planExplanation, active.planSteps, {
      latestVersion: session?.latestPlanVersion ?? null,
      confirmedVersion: session?.confirmedPlanVersion ?? null,
      draftText: active.planDraftText,
    });
    const existingMessageId = active.planMessageId ?? session?.lastPlanMessageId ?? null;
    if (existingMessageId !== null && active.planText === html) {
      return;
    }
    if (existingMessageId !== null) {
      try {
        await this.host.editHtmlMessage(active.scopeId, existingMessageId, html, []);
        active.planMessageId = existingMessageId;
        active.planText = html;
        active.planLastRenderedAt = Date.now();
        if (session) {
          this.updateSession(session.sessionId, {
            lastPlanMessageId: existingMessageId,
          });
        }
        return;
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.host.logger.warn('telegram.plan_update_edit_failed', {
            turnId: active.turnId,
            messageId: existingMessageId,
            error: String(error),
          });
        }
      }
    }
    const messageId = await this.host.sendHtmlMessage(active.scopeId, html);
    active.planMessageId = messageId;
    active.planText = html;
    active.planLastRenderedAt = Date.now();
    if (session) {
      this.updateSession(session.sessionId, {
        lastPlanMessageId: messageId,
      });
    }
  }

  private updateSession(
    sessionId: string,
    updates: Partial<GuidedPlanSession>,
  ): GuidedPlanSession | null {
    const current = this.host.store.getPlanSession(sessionId);
    if (!current) {
      return null;
    }
    const next: GuidedPlanSession = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
    };
    this.host.store.savePlanSession(next);
    return next;
  }

  private buildPlanTurnInput(text: string): TurnInput[] {
    return [{
      type: 'text',
      text,
      text_elements: [],
    }];
  }

  private async finalizeDraftTurn(active: GuidedPlanTurnState, session: GuidedPlanSession): Promise<void> {
    if (active.interruptRequested && !active.guidedPlanExecutionBlocked) {
      this.updateSession(session.sessionId, {
        state: 'interrupted',
        currentPromptId: null,
        resolvedAt: Date.now(),
      });
      await this.host.sendMessage(active.scopeId, t(this.host.localeForChat(active.scopeId), 'plan_draft_interrupted'));
      this.host.updateStatus();
      return;
    }
    const nextSession = this.updateSession(session.sessionId, {
      threadId: active.threadId,
      sourceTurnId: active.turnId,
      executionTurnId: null,
      state: 'awaiting_plan_confirmation',
      currentPromptId: crypto.randomBytes(6).toString('hex'),
      resolvedAt: null,
    });
    if (!nextSession) {
      return;
    }
    const locale = this.host.localeForChat(active.scopeId);
    const rendered = renderPlanConfirmationMessage(locale, nextSession, {
      blockedExecution: active.guidedPlanExecutionBlocked,
    });
    const promptMessageId = await this.upsertPlanConfirmationPrompt(nextSession, rendered);
    this.updateSession(session.sessionId, {
      lastPromptMessageId: promptMessageId,
    });
    this.host.updateStatus();
  }

  private async upsertPlanConfirmationPrompt(
    session: GuidedPlanSession,
    rendered: { html: string; keyboard: InlineKeyboard },
  ): Promise<number> {
    if (session.lastPromptMessageId !== null) {
      try {
        await this.host.editHtmlMessage(session.chatId, session.lastPromptMessageId, rendered.html, rendered.keyboard);
        return session.lastPromptMessageId;
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          throw error;
        }
      }
    }
    return this.host.sendHtmlMessage(session.chatId, rendered.html, rendered.keyboard);
  }
}

function planRecoveryKeyboard(
  locale: AppLocale,
  sessionId: string,
): InlineKeyboard {
  return [
    [{
      text: truncateInline(`${t(locale, 'button_recommended')}: ${t(locale, 'button_continue')}`, 32),
      callback_data: `recover:${sessionId}:continue`,
    }],
    [{
      text: t(locale, 'button_show_plan'),
      callback_data: `recover:${sessionId}:show`,
    }],
    [{
      text: t(locale, 'button_cancel'),
      callback_data: `recover:${sessionId}:cancel`,
    }],
  ];
}

function planConfirmationKeyboard(
  locale: AppLocale,
  sessionId: string,
  canConfirm: boolean,
): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (canConfirm) {
    rows.push([{
      text: truncateInline(`${t(locale, 'button_recommended')}: ${t(locale, 'button_confirm_execute')}`, 32),
      callback_data: `plan:${sessionId}:confirm`,
    }]);
  }
  rows.push([
    { text: t(locale, 'button_revise'), callback_data: `plan:${sessionId}:revise` },
    { text: t(locale, 'button_cancel'), callback_data: `plan:${sessionId}:cancel` },
  ]);
  return rows;
}

function renderTurnPlanMessage(
  locale: AppLocale,
  explanation: string | null,
  plan: Array<{ step: string; status: string }>,
  options: {
    latestVersion?: number | null;
    confirmedVersion?: number | null;
    draftText?: string | null;
  } = {},
): string {
  const lines = [t(locale, 'plan_updated')];
  if (options.latestVersion !== null && options.latestVersion !== undefined) {
    lines.push(t(locale, 'plan_current_version', { value: options.latestVersion }));
  }
  if (options.confirmedVersion !== null && options.confirmedVersion !== undefined) {
    lines.push(t(locale, 'plan_confirmed_version', { value: options.confirmedVersion }));
  }
  if (explanation) {
    lines.push(t(locale, 'plan_explanation', { value: escapeTelegramHtml(explanation) }));
  }
  const stepLines = plan
    .map((step, index) => {
      const label = step.step.trim();
      if (!label) {
        return null;
      }
      return `${index + 1}. [${formatPlanStepStatus(locale, step.status)}] ${escapeTelegramHtml(label)}`;
    })
    .filter((line): line is string => Boolean(line));
  if (stepLines.length > 0) {
    lines.push(`<blockquote expandable>${stepLines.join('\n')}</blockquote>`);
  }
  const draftText = options.draftText?.trim();
  if (draftText) {
    lines.push(t(locale, 'plan_streaming_update'));
    lines.push(`<blockquote expandable>${escapeTelegramHtml(truncateInline(draftText, 1200))}</blockquote>`);
  }
  return lines.join('\n');
}

function normalizePlanSteps(plan: Array<{ step?: unknown; status?: unknown }>): Array<{ step: string; status: string }> {
  return plan
    .map((step) => ({
      step: typeof step?.step === 'string' ? step.step.trim() : '',
      status: typeof step?.status === 'string' ? step.status : 'pending',
    }))
    .filter((step) => step.step);
}

function planStepsEqual(
  left: Array<{ step: string; status: string }>,
  right: Array<{ step: string; status: string }>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((step, index) => step.step === right[index]?.step && step.status === right[index]?.status);
}

export function renderPlanConfirmationMessage(
  locale: AppLocale,
  session: GuidedPlanSession,
  options: { blockedExecution?: boolean } = {},
): { html: string; keyboard: InlineKeyboard } {
  const hasReviewablePlan = canConfirmPlanSession(session);
  const lines = [
    t(locale, 'plan_ready_for_review'),
    t(locale, 'line_thread', { value: escapeTelegramHtml(session.threadId) }),
  ];
  if (session.sourceTurnId) {
    lines.push(t(locale, 'line_turn', { value: escapeTelegramHtml(session.sourceTurnId) }));
  }
  if (session.latestPlanVersion !== null) {
    lines.push(t(locale, 'plan_review_version', { value: session.latestPlanVersion }));
  }
  if (options.blockedExecution) {
    lines.push(t(locale, 'plan_review_blocked_execution'));
  }
  lines.push(t(locale, session.latestPlanVersion !== null
    ? 'plan_review_prompt'
    : hasReviewablePlan
      ? 'plan_review_prompt_visible_plan'
      : 'plan_review_prompt_no_snapshot'));
  lines.push(t(locale, hasReviewablePlan ? 'plan_review_actions' : 'plan_review_actions_revise_only'));
  return {
    html: lines.filter(Boolean).join('\n'),
    keyboard: planConfirmationKeyboard(locale, session.sessionId, hasReviewablePlan),
  };
}

function canConfirmPlanSession(session: GuidedPlanSession): boolean {
  return session.latestPlanVersion !== null || session.lastPlanMessageId !== null;
}

export function renderResolvedPlanConfirmationMessage(
  locale: AppLocale,
  session: GuidedPlanSession,
  action: PlanSessionAction,
): string {
  const decisionKey = action === 'confirm'
    ? 'plan_decision_continue'
    : action === 'revise'
      ? 'plan_decision_revise'
      : 'plan_decision_cancel';
  const lines = [
    t(locale, 'plan_decision_recorded'),
    t(locale, 'line_thread', { value: escapeTelegramHtml(session.threadId) }),
  ];
  if (session.sourceTurnId) {
    lines.push(t(locale, 'line_turn', { value: escapeTelegramHtml(session.sourceTurnId) }));
  }
  if (session.latestPlanVersion !== null) {
    lines.push(t(locale, 'plan_review_version', { value: session.latestPlanVersion }));
  }
  lines.push(t(locale, 'line_decision', { value: escapeTelegramHtml(t(locale, decisionKey)) }));
  return lines.join('\n');
}

export function renderPlanRecoveryMessage(
  locale: AppLocale,
  session: GuidedPlanSession,
  latestSnapshot: { version: number; explanation: string | null; steps: PlanSnapshotStep[] } | null,
): { html: string; keyboard: InlineKeyboard } {
  const lines = [
    t(locale, 'plan_recovery_title'),
    t(locale, 'line_thread', { value: escapeTelegramHtml(session.threadId) }),
  ];
  if (session.sourceTurnId) {
    lines.push(t(locale, 'line_turn', { value: escapeTelegramHtml(session.sourceTurnId) }));
  }
  if (latestSnapshot) {
    lines.push(t(locale, 'plan_review_version', { value: latestSnapshot.version }));
  }
  lines.push(t(locale, 'plan_recovery_prompt'));
  return {
    html: lines.join('\n'),
    keyboard: planRecoveryKeyboard(locale, session.sessionId),
  };
}

export function renderResolvedPlanRecoveryMessage(
  locale: AppLocale,
  session: GuidedPlanSession,
  action: PlanRecoveryAction,
): string {
  const lines = [
    t(locale, 'plan_recovery_recorded'),
    t(locale, 'line_thread', { value: escapeTelegramHtml(session.threadId) }),
  ];
  if (session.sourceTurnId) {
    lines.push(t(locale, 'line_turn', { value: escapeTelegramHtml(session.sourceTurnId) }));
  }
  lines.push(t(locale, 'line_decision', {
    value: escapeTelegramHtml(t(locale, action === 'continue'
      ? 'plan_recovery_decision_continue'
      : action === 'show'
        ? 'plan_recovery_decision_show'
        : 'plan_recovery_decision_cancel')),
  }));
  return lines.join('\n');
}

export function renderRecoveredPlanSnapshotMessage(
  locale: AppLocale,
  session: GuidedPlanSession,
  snapshot: { version: number; explanation: string | null; steps: PlanSnapshotStep[] },
): string {
  return [
    t(locale, 'plan_recovery_snapshot_title'),
    t(locale, 'line_thread', { value: escapeTelegramHtml(session.threadId) }),
    renderTurnPlanMessage(locale, snapshot.explanation, snapshot.steps, {
      latestVersion: snapshot.version,
      confirmedVersion: session.confirmedPlanVersion,
    }),
  ].join('\n');
}

function formatPlanStepStatus(locale: AppLocale, status: unknown): string {
  if (status === 'completed') {
    return t(locale, 'plan_status_completed');
  }
  if (status === 'inProgress') {
    return t(locale, 'plan_status_in_progress');
  }
  return t(locale, 'plan_status_pending');
}

function truncateInline(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isTelegramMessageGone(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message to delete not found')
    || message.includes('message to edit not found')
    || message.includes('message not found');
}
