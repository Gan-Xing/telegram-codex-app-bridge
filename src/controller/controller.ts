import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { normalizeLocale, t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import { DEFAULT_GUIDED_PLAN_PREFERENCES } from '../types.js';
import type {
  AccountRateLimitSnapshot,
  AppLocale,
  AppThreadTurn,
  AppThreadTurnItem,
  AppThreadWithTurns,
  CollaborationModeValue,
  GuidedPlanSession,
  ModelInfo,
  PendingApprovalRecord,
  PendingUserInputQuestion,
  PendingUserInputRecord,
  PlanSnapshotStep,
  QueuedTurnInputRecord,
  ReasoningEffortValue,
  RuntimeStatus,
  SandboxModeValue,
  ThreadBinding,
  ThreadSessionState,
} from '../types.js';
import { parseCommand } from './commands.js';
import {
  buildAccessSettingsKeyboard,
  buildSettingsHomeKeyboard,
  buildModeSettingsKeyboard,
  buildModelSettingsKeyboard,
  buildThreadsKeyboard,
  clampEffortToModel,
  formatCollaborationModeLabel,
  formatAccessPresetLabel,
  formatAccessSettingsMessage,
  formatApprovalPolicyLabel,
  formatModeSettingsMessage,
  formatModelSettingsMessage,
  formatSettingsHomeMessage,
  formatThreadHistoryPreviewMessage,
  formatSandboxModeLabel,
  formatThreadsMessage,
  formatWhereMessage,
  normalizeRequestedEffort,
  resolveCurrentModel,
  resolveRequestedModel,
  type ThreadHistoryPreviewTurn,
} from './presentation.js';
import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';
import {
  TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES,
  buildAttachmentPrompt,
  isNativeImageAttachment,
  planAttachmentStoragePath,
  summarizeTelegramInput,
  type StagedTelegramAttachment,
  type TelegramInboundAttachment,
} from '../telegram/media.js';
import { chunkTelegramMessage, chunkTelegramStreamMessage, clipTelegramDraftMessage } from '../telegram/text.js';
import { isDefaultTelegramScope, resolveTelegramAddressing } from '../telegram/addressing.js';
import { parseTelegramScopeId } from '../telegram/scope.js';
import { resolveTelegramRenderRoute, type TelegramRenderRoute } from '../telegram/rendering.js';
import {
  PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  type CodexAppClient,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
  type TurnInput,
} from '../codex_app/client.js';
import {
  classifyAgentOutput,
  normalizeTurnActivityEvent,
  type RawExecCommandEvent,
  type TurnActivityEvent,
  type TurnOutputKind,
} from './activity.js';
import { normalizeAccessPreset, resolveAccessMode } from './access.js';
import { renderActiveTurnStatus } from './status.js';
import { writeRuntimeStatus } from '../runtime.js';

interface RenderedTelegramMessage {
  messageId: number;
  text: string;
}

interface ActiveTurnSegment {
  itemId: string;
  phase: string | null;
  outputKind: TurnOutputKind;
  text: string;
  completed: boolean;
  messages: RenderedTelegramMessage[];
}

interface ToolBatchCounts {
  files: number;
  searches: number;
  edits: number;
  commands: number;
}

interface ToolBatchState {
  openCallIds: Set<string>;
  actionKeys: Set<string>;
  actionLines: string[];
  counts: ToolBatchCounts;
  finalizeTimer: NodeJS.Timeout | null;
}

interface ArchivedStatusContent {
  text: string;
  html: string | null;
}

interface ToolDescriptor {
  kind: keyof ToolBatchCounts;
  key: string;
  line: string;
}

interface ThreadRenameDraft {
  threadId: string;
  currentName: string;
  proposedName: string | null;
  promptMessageId: number;
  createdAt: number;
}

interface ActiveTurn {
  scopeId: string;
  chatId: string;
  topicId: number | null;
  renderRoute: TelegramRenderRoute;
  threadId: string;
  turnId: string;
  queuedInputId: string | null;
  previewMessageId: number;
  previewActive: boolean;
  draftId: number | null;
  draftText: string | null;
  buffer: string;
  finalText: string | null;
  interruptRequested: boolean;
  statusMessageText: string | null;
  statusNeedsRebase: boolean;
  segments: ActiveTurnSegment[];
  reasoningActiveCount: number;
  pendingApprovalKinds: Set<PendingApprovalRecord['kind']>;
  pendingUserInputId: string | null;
  toolBatch: ToolBatchState | null;
  pendingArchivedStatus: ArchivedStatusContent | null;
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
  renderRetryTimer: NodeJS.Timeout | null;
  lastStreamFlushAt: number;
  renderRequested: boolean;
  forceStatusFlush: boolean;
  forceStreamFlush: boolean;
  renderTask: Promise<void> | null;
  resolver: () => void;
}

type ApprovalAction = 'accept' | 'session' | 'deny';
type PlanSessionAction = 'confirm' | 'revise' | 'cancel';
type PlanRecoveryAction = 'continue' | 'show' | 'cancel';
class UserFacingError extends Error {}

const PLAN_MODE_DRAFT_ONLY_DEVELOPER_INSTRUCTIONS = [
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
const HISTORY_RETENTION_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_RESOLVED_PLAN_SESSIONS_PER_CHAT = 20;
const THREAD_HISTORY_PREVIEW_TURN_LIMIT = 3;

export class BridgeController {
  private activeTurns = new Map<string, ActiveTurn>();
  private threadRenameDrafts = new Map<string, ThreadRenameDraft>();
  private locks = new Map<string, Promise<void>>();
  private approvalTimers = new Map<string, NodeJS.Timeout>();
  private attachedThreads = new Set<string>();
  private botUsername: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: BridgeStore,
    private readonly logger: Logger,
    private readonly bot: TelegramGateway,
    private readonly app: CodexAppClient,
  ) {}

  async start(): Promise<void> {
    this.bot.on('text', (event: TelegramTextEvent) => {
      void this.withLock(event.scopeId, async () => this.handleText(event)).catch((error) => {
        void this.handleAsyncError('telegram.text', error, event.scopeId);
      });
    });
    this.bot.on('callback', (event: TelegramCallbackEvent) => {
      void this.withLock(event.scopeId, async () => this.handleCallback(event)).catch((error) => {
        void this.handleAsyncError('telegram.callback', error, event.scopeId);
      });
    });
    this.app.on('notification', (msg: JsonRpcNotification) => {
      void this.handleNotification(msg).catch((error) => {
        void this.handleAsyncError('codex.notification', error);
      });
    });
    this.app.on('serverRequest', (msg: JsonRpcServerRequest) => {
      void this.handleServerRequest(msg).catch((error) => {
        void this.handleAsyncError('codex.server_request', error);
      });
    });
    this.app.on('connected', () => {
      this.attachedThreads.clear();
      this.lastError = null;
      this.updateStatus();
    });
    this.app.on('disconnected', () => {
      this.attachedThreads.clear();
      void this.abandonActiveTurns().catch((error) => {
        this.logger.error('codex.disconnect_cleanup_failed', { error: toErrorMeta(error) });
      });
      this.updateStatus();
    });

    await this.app.start();
    await this.cleanupStaleTurnPreviews();
    const requeuedTurnInputs = this.store.requeueInterruptedQueuedTurnInputs();
    const cleanupResult = this.store.cleanupHistoricalRecords({
      maxResolvedAgeMs: HISTORY_RETENTION_MS,
      maxResolvedPlanSessionsPerChat: MAX_RESOLVED_PLAN_SESSIONS_PER_CHAT,
    });
    if (requeuedTurnInputs > 0 || Object.values(cleanupResult).some((count) => count > 0)) {
      this.logger.info('store.startup_maintenance', {
        requeuedTurnInputs,
        ...cleanupResult,
      });
    }
    await this.bot.start();
    this.botUsername = this.bot.username;
    await this.recoverPersistentState();
    this.updateStatus();
  }

  async stop(): Promise<void> {
    await this.abandonActiveTurns();
    this.threadRenameDrafts.clear();
    this.bot.stop();
    for (const timer of this.approvalTimers.values()) {
      clearTimeout(timer);
    }
    this.approvalTimers.clear();
    await this.app.stop();
    this.updateStatus();
  }

  getRuntimeStatus(): RuntimeStatus {
    const accountRateLimits = typeof (this.app as { getAccountRateLimits?: () => AccountRateLimitSnapshot | null }).getAccountRateLimits === 'function'
      ? this.app.getAccountRateLimits()
      : null;
    return {
      running: true,
      connected: this.app.isConnected(),
      userAgent: this.app.getUserAgent(),
      botUsername: this.botUsername,
      currentBindings: this.store.countBindings(),
      pendingApprovals: this.store.countPendingApprovals(),
      pendingUserInputs: this.store.countPendingUserInputs(),
      queuedTurns: this.store.countQueuedTurnInputs(),
      activeTurns: this.activeTurns.size,
      accountRateLimits,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    };
  }

  private async readStatusRateLimits(): Promise<AccountRateLimitSnapshot | null> {
    const app = this.app as {
      getAccountRateLimits?: () => AccountRateLimitSnapshot | null;
      readAccountRateLimits?: () => Promise<AccountRateLimitSnapshot | null>;
    };
    if (!this.app.isConnected()) {
      return typeof app.getAccountRateLimits === 'function' ? app.getAccountRateLimits() : null;
    }
    if (typeof app.readAccountRateLimits !== 'function') {
      return typeof app.getAccountRateLimits === 'function' ? app.getAccountRateLimits() : null;
    }
    try {
      return await app.readAccountRateLimits();
    } catch (error) {
      this.logger.warn('codex.account_rate_limits_status_failed', { error: String(error) });
      return typeof app.getAccountRateLimits === 'function' ? app.getAccountRateLimits() : null;
    }
  }

  private async handleText(event: TelegramTextEvent): Promise<void> {
    const scopeId = event.scopeId;
    const locale = this.localeForChat(scopeId, event.languageCode);
    this.store.insertAudit('inbound', scopeId, 'telegram.message', summarizeTelegramInput(event.text, event.attachments));
    const command = event.attachments.length === 0 ? parseCommand(event.text) : null;
    const decision = resolveTelegramAddressing({
      text: event.text,
      attachmentsCount: event.attachments.length,
      entities: event.entities,
      command,
      botUsername: this.botUsername,
      isDefaultTopic: isDefaultTelegramScope({
        chatType: event.chatType,
        allowedChatId: this.config.tgAllowedChatId,
        allowedTopicId: this.config.tgAllowedTopicId,
        topicId: event.topicId,
      }),
      replyToBot: event.replyToBot,
    });
    if (decision.kind === 'ignore') {
      return;
    }
    if (decision.kind === 'command') {
      await this.handleCommand(event, locale, decision.command.name, decision.command.args);
      return;
    }

    const pendingUserInput = this.store.getPendingUserInputForChat(scopeId);
    if (pendingUserInput) {
      if (!this.shouldAllowInteractiveUserInput(scopeId)) {
        await this.cancelPendingUserInput(pendingUserInput, locale);
      } else {
        await this.handlePendingUserInputText(scopeId, pendingUserInput, decision.text, locale);
        return;
      }
    }

    const threadRenameDraft = this.threadRenameDrafts.get(scopeId) ?? null;
    if (threadRenameDraft) {
      await this.handleThreadRenameText(scopeId, threadRenameDraft, decision.text, locale);
      return;
    }

    const awaitingPlanConfirmation = this.getAwaitingPlanConfirmationSession(scopeId);
    if (awaitingPlanConfirmation) {
      await this.sendMessage(scopeId, t(locale, 'plan_confirmation_pending'));
      return;
    }
    const recoveryRequiredSession = this.store.listOpenPlanSessions(scopeId)
      .find((session) => session.state === 'recovery_required') ?? null;
    if (recoveryRequiredSession) {
      await this.sendMessage(scopeId, t(locale, 'plan_recovery_pending'));
      return;
    }

    const activeTurn = this.findActiveTurn(scopeId);
    if (activeTurn) {
      const settings = this.store.getChatSettings(scopeId);
      if (!(settings?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages)) {
        await this.sendMessage(scopeId, t(locale, 'another_turn_running'));
        return;
      }
      await this.sendTyping(scopeId);
      await this.enqueueTurnInput(
        this.resolveActiveTurnBinding(scopeId, activeTurn),
        { ...event, text: decision.text },
        locale,
      );
      return;
    }

    const existingBinding = this.store.getBinding(scopeId);
    const binding = existingBinding
      ? await this.ensureThreadReady(scopeId, existingBinding)
      : await this.createBinding(scopeId, null);
    await this.sendTyping(scopeId);
    const input = await this.buildTurnInput(binding, { ...event, text: decision.text }, locale);
    await this.startIncomingTurn(scopeId, event.chatId, event.chatType, event.topicId, binding, input);
  }

  private async handleCommand(event: TelegramTextEvent, locale: AppLocale, name: string, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    switch (name) {
      case 'start':
      case 'help': {
        await this.sendMessage(scopeId, [
          t(locale, 'help_commands_title'),
          '/help',
          '/status',
          '/threads [query]',
          '/open <n>',
          '/new [cwd]',
          '/models',
          '/mode',
          '/settings',
          '/queue',
          '/permissions',
          '/reveal',
          '/where',
          '/interrupt',
          t(locale, 'help_advanced_aliases'),
          t(locale, 'help_plain_text_hint'),
        ].join('\n'));
        return;
      }
      case 'status': {
        const binding = this.store.getBinding(scopeId);
        const settings = this.store.getChatSettings(scopeId);
        const access = this.resolveEffectiveAccess(scopeId, settings);
        const rateLimits = await this.readStatusRateLimits();
        this.updateStatus();
        const lines = [
          t(locale, 'status_connected', { value: t(locale, this.app.isConnected() ? 'yes' : 'no') }),
          t(locale, 'status_user_agent', { value: this.app.getUserAgent() ?? t(locale, 'unknown') }),
          t(locale, 'status_current_thread', { value: binding?.threadId ?? t(locale, 'none') }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
          t(locale, 'status_mode', { value: formatCollaborationModeLabel(locale, settings?.collaborationMode ?? null) }),
          ...formatRateLimitStatusLines(locale, rateLimits),
          t(locale, 'status_confirm_plan_before_execute', {
            value: t(locale, (settings?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute) ? 'yes' : 'no'),
          }),
          t(locale, 'status_auto_queue_messages', {
            value: t(locale, (settings?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages) ? 'yes' : 'no'),
          }),
          t(locale, 'status_persist_plan_history', {
            value: t(locale, (settings?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory) ? 'yes' : 'no'),
          }),
          t(locale, 'status_access_preset', { value: formatAccessPresetLabel(locale, access.preset) }),
          t(locale, 'status_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy) }),
          t(locale, 'status_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode) }),
          t(locale, 'status_sync_on_open', { value: t(locale, this.config.codexAppSyncOnOpen ? 'yes' : 'no') }),
          t(locale, 'status_sync_on_turn_complete', { value: t(locale, this.config.codexAppSyncOnTurnComplete ? 'yes' : 'no') }),
          t(locale, 'status_pending_approvals', { value: this.store.countPendingApprovals() }),
          t(locale, 'status_pending_user_inputs', { value: this.store.countPendingUserInputs() }),
          t(locale, 'status_queue_depth', { value: this.store.countQueuedTurnInputs(scopeId) }),
          t(locale, 'status_active_turns', { value: this.activeTurns.size }),
        ];
        await this.sendMessage(scopeId, lines.join('\n'));
        return;
      }
      case 'where': {
        await this.showWherePanel(scopeId, undefined, locale);
        return;
      }
      case 'threads': {
        const searchTerm = args.join(' ').trim() || null;
        await this.showThreadsPanel(scopeId, undefined, searchTerm, locale);
        return;
      }
      case 'open': {
        const target = Number.parseInt(args[0] || '', 10);
        if (!Number.isFinite(target)) {
          await this.sendMessage(scopeId, t(locale, 'usage_open'));
          return;
        }
        const thread = this.store.getCachedThread(scopeId, target);
        if (!thread) {
          await this.sendMessage(scopeId, t(locale, 'unknown_cached_thread'));
          return;
        }
        let binding: ThreadBinding;
        try {
          binding = await this.bindCachedThread(scopeId, thread.threadId);
        } catch (error) {
          if (isThreadNotFoundError(error)) {
            await this.sendMessage(scopeId, t(locale, 'cached_thread_unavailable'));
            return;
          }
          throw error;
        }
        const settings = this.store.getChatSettings(scopeId);
        const lines = [
          t(locale, 'bound_to_thread', { threadId: binding.threadId }),
          t(locale, 'line_title', { value: thread.name || thread.preview || t(locale, 'empty') }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
          t(locale, 'line_cwd', { value: binding.cwd ?? this.config.defaultCwd }),
        ];
        if (this.config.codexAppSyncOnOpen) {
          const revealError = await this.tryRevealThread(scopeId, binding.threadId, 'open');
          lines.push(revealError ? t(locale, 'codex_sync_failed', { error: revealError }) : t(locale, 'opened_in_codex'));
        }
        await this.sendMessage(scopeId, lines.join('\n'));
        await this.renderThreadHistoryPreview(scopeId, binding.threadId, locale);
        return;
      }
      case 'new': {
        const cwd = args.join(' ').trim() || this.config.defaultCwd;
        const binding = await this.createBinding(scopeId, cwd);
        const settings = this.store.getChatSettings(scopeId);
        await this.sendMessage(scopeId, [
          t(locale, 'started_new_thread', { threadId: binding.threadId }),
          t(locale, 'line_cwd', { value: binding.cwd ?? cwd }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
        ].join('\n'));
        return;
      }
      case 'model': {
        await this.handleModelCommand(event, locale, args);
        return;
      }
      case 'models': {
        await this.showModelSettingsPanel(scopeId, undefined, locale);
        return;
      }
      case 'mode': {
        await this.handleModeCommand(event, locale, args);
        return;
      }
      case 'settings': {
        await this.showSettingsHomePanel(scopeId, undefined, locale);
        return;
      }
      case 'queue': {
        await this.handleQueueCommand(event, locale, args);
        return;
      }
      case 'permissions':
      case 'access': {
        await this.showAccessSettingsPanel(scopeId, undefined, locale);
        return;
      }
      case 'plan': {
        await this.handlePlanAliasCommand(event, locale, args);
        return;
      }
      case 'effort': {
        await this.handleEffortCommand(event, locale, args);
        return;
      }
      case 'reveal':
      case 'focus': {
        const binding = this.store.getBinding(scopeId);
        if (!binding) {
          await this.sendMessage(scopeId, t(locale, 'no_thread_bound_reveal'));
          return;
        }
        const readyBinding = await this.ensureThreadReady(scopeId, binding);
        const revealError = await this.tryRevealThread(scopeId, readyBinding.threadId, 'reveal');
        if (revealError) {
          await this.sendMessage(scopeId, t(locale, 'failed_open_codex', { error: revealError }));
          return;
        }
        await this.sendMessage(scopeId, t(locale, 'opened_thread_in_codex', { threadId: readyBinding.threadId }));
        return;
      }
      case 'interrupt': {
        const active = this.findActiveTurn(scopeId);
        if (!active) {
          await this.sendMessage(scopeId, t(locale, 'no_active_turn'));
          return;
        }
        await this.requestInterrupt(active);
        await this.sendMessage(scopeId, t(locale, 'interrupt_requested_for', { turnId: active.turnId }));
        return;
      }
      default: {
        await this.sendMessage(scopeId, t(locale, 'unknown_command', { name }));
      }
    }
  }

  private async handleCallback(event: TelegramCallbackEvent): Promise<void> {
    const scopeId = event.scopeId;
    const locale = this.localeForChat(scopeId, event.languageCode);
    const interruptMatch = /^turn:interrupt:(.+)$/.exec(event.data);
    if (interruptMatch) {
      await this.handleTurnInterruptCallback(event, interruptMatch[1]!, locale);
      return;
    }
    const threadMatch = /^thread:open:(.+)$/.exec(event.data);
    if (threadMatch) {
      await this.handleThreadOpenCallback(event, threadMatch[1]!, locale);
      return;
    }
    const threadRenameMatch = /^thread:rename:(start|confirm|cancel):(.+)$/.exec(event.data);
    if (threadRenameMatch) {
      await this.handleThreadRenameCallback(
        event,
        threadRenameMatch[1]! as 'start' | 'confirm' | 'cancel',
        threadRenameMatch[2]!,
        locale,
      );
      return;
    }
    const navMatch = /^nav:(models|mode|threads|reveal|permissions)$/.exec(event.data);
    if (navMatch) {
      await this.handleNavigationCallback(event, navMatch[1]! as 'models' | 'mode' | 'threads' | 'reveal' | 'permissions', locale);
      return;
    }
    if (event.data === 'settings:home') {
      await this.showSettingsHomePanel(scopeId, event.messageId, locale);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'opened_settings_home'));
      return;
    }
    const guidedSettingsMatch = /^settings:(plan-gate|queue|history):(on|off)$/.exec(event.data);
    if (guidedSettingsMatch) {
      await this.handleGuidedPlanSettingsCallback(
        event,
        guidedSettingsMatch[1]! as 'plan-gate' | 'queue' | 'history',
        guidedSettingsMatch[2]! as 'on' | 'off',
        locale,
      );
      return;
    }
    const settingsMatch = /^settings:(model|effort|mode|access):(.+)$/.exec(event.data);
    if (settingsMatch) {
      await this.handleSettingsCallback(event, settingsMatch[1]! as 'model' | 'effort' | 'mode' | 'access', settingsMatch[2]!, locale);
      return;
    }
    const planMatch = /^plan:([a-f0-9]+):(confirm|revise|cancel)$/.exec(event.data);
    if (planMatch) {
      await this.handlePlanSessionCallback(event, planMatch[1]!, planMatch[2]! as PlanSessionAction, locale);
      return;
    }
    const recoveryMatch = /^recover:([a-f0-9]+):(continue|show|cancel)$/.exec(event.data);
    if (recoveryMatch) {
      await this.handlePlanRecoveryCallback(event, recoveryMatch[1]!, recoveryMatch[2]! as PlanRecoveryAction, locale);
      return;
    }
    const queueMatch = /^queue:(next|clear)$/.exec(event.data);
    if (queueMatch) {
      await this.handleQueueCallback(event, queueMatch[1]! as 'next' | 'clear', locale);
      return;
    }
    const inputMatch = /^input:([a-f0-9]+):(other|back|cancel|submit|edit:\d+|option:\d+)$/.exec(event.data);
    if (inputMatch) {
      await this.handlePendingUserInputCallback(event, inputMatch[1]!, inputMatch[2]!, locale);
      return;
    }
    const match = /^approval:([a-f0-9]+):(accept|session|deny|details|back)$/.exec(event.data);
    if (!match) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    const localId = match[1]!;
    const action = match[2]! as ApprovalAction | 'details' | 'back';
    const approval = this.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'approval_already_resolved'));
      return;
    }
    if (approval.chatId !== scopeId || (approval.messageId !== null && approval.messageId !== event.messageId)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'approval_mismatch'));
      return;
    }
    if (action === 'details' || action === 'back') {
      if (approval.messageId !== null) {
        await this.editMessage(
          scopeId,
          approval.messageId,
          action === 'details' ? renderApprovalDetailsMessage(locale, approval) : renderApprovalMessage(locale, approval),
          approvalKeyboard(locale, approval.localId, action === 'details'),
        );
      }
      await this.bot.answerCallback(event.callbackQueryId, t(locale, action === 'details' ? 'approval_showing_details' : 'approval_showing_summary'));
      return;
    }

    const result = mapApprovalDecision(action);
    await this.app.respond(approval.serverRequestId, result);
    this.store.markApprovalResolved(localId);
    this.clearApprovalTimer(localId);
    await this.clearPendingApprovalStatus(approval.threadId, approval.kind);
    await this.bot.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    if (approval.messageId !== null) {
      await this.editMessage(scopeId, approval.messageId, renderApprovalMessage(locale, approval, action));
    }
    this.updateStatus();
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    const activity = normalizeTurnActivityEvent(notification);
    if (activity) {
      await this.handleTurnActivityEvent(activity);
      return;
    }

    switch (notification.method) {
      case 'sessionConfigured': {
        const params = notification.params as any;
        const threadId = String(params.session_id || '');
        if (!threadId) return;
        const scopeId = this.findChatByThread(threadId);
        if (!scopeId) return;
        const binding = this.store.getBinding(scopeId);
        const cwd = params.cwd ? String(params.cwd) : binding?.cwd ?? null;
        this.store.setBinding(scopeId, threadId, cwd);
        const current = this.store.getChatSettings(scopeId);
        const preserveDefaultModel = current !== null && current.model === null;
        const preserveDefaultEffort = current !== null && current.reasoningEffort === null;
        this.store.setChatSettings(
          scopeId,
          preserveDefaultModel
            ? null
            : params.model
              ? String(params.model)
              : current?.model ?? null,
          preserveDefaultEffort
            ? null
            : params.reasoning_effort === undefined
              ? current?.reasoningEffort ?? null
              : params.reasoning_effort === null
                ? null
                : String(params.reasoning_effort) as ReasoningEffortValue,
        );
        this.updateStatus();
        return;
      }
      case 'turn/plan/updated': {
        const params = notification.params as any;
        const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
        if (!turnId) return;
        const active = this.activeTurns.get(turnId);
        if (!active) return;
        await this.syncTurnPlan(active, params);
        return;
      }
      case 'item/plan/delta': {
        const params = notification.params as any;
        const turnId = typeof params?.turnId === 'string'
          ? params.turnId
          : typeof params?.turn_id === 'string'
            ? params.turn_id
            : null;
        const delta = typeof params?.delta === 'string' ? params.delta : null;
        if (!turnId || !delta) return;
        const active = this.activeTurns.get(turnId);
        if (!active) return;
        active.planDraftText = `${active.planDraftText ?? ''}${delta}`;
        await this.queuePlanRender(active);
        return;
      }
      case 'account/rateLimits/updated': {
        this.updateStatus();
        return;
      }
      case 'error': {
        this.lastError = JSON.stringify(notification.params ?? {});
        this.logger.error('codex.notification.error', notification.params);
        this.updateStatus();
        return;
      }
      default:
        return;
    }
  }

  private async handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const params = request.params as any;
        if (await this.rejectDraftOnlyApprovalRequestIfNeeded(request.id, params)) {
          return;
        }
        const approval = this.createApprovalRecord('command', request.id, params);
        await this.notePendingApprovalStatus(approval.threadId, approval.kind);
        const locale = this.localeForChat(approval.chatId);
        const messageId = await this.sendMessage(approval.chatId, renderApprovalMessage(locale, approval), approvalKeyboard(locale, approval.localId));
        this.store.updatePendingApprovalMessage(approval.localId, messageId);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/fileChange/requestApproval': {
        const params = request.params as any;
        if (await this.rejectDraftOnlyApprovalRequestIfNeeded(request.id, params)) {
          return;
        }
        const approval = this.createApprovalRecord('fileChange', request.id, params);
        await this.notePendingApprovalStatus(approval.threadId, approval.kind);
        const locale = this.localeForChat(approval.chatId);
        const messageId = await this.sendMessage(approval.chatId, renderApprovalMessage(locale, approval), approvalKeyboard(locale, approval.localId));
        this.store.updatePendingApprovalMessage(approval.localId, messageId);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/tool/requestUserInput': {
        const params = request.params as any;
        const threadId = typeof params?.threadId === 'string' ? params.threadId : String(params?.threadId || '');
        const scopeId = threadId ? this.findChatByThread(threadId) : null;
        if (scopeId && !this.shouldAllowInteractiveUserInput(scopeId)) {
          const locale = this.localeForChat(scopeId);
          await this.app.respondError(
            request.id,
            'Interactive requestUserInput is only available in plan mode for this chat.',
          );
          await this.sendMessage(scopeId, t(locale, 'input_plan_mode_only'));
          return;
        }
        const pendingInput = this.createPendingUserInputRecord(request.id, params);
        await this.notePendingUserInputStatus(pendingInput.threadId, pendingInput.localId);
        const locale = this.localeForChat(pendingInput.chatId);
        const messageId = await this.openPendingUserInputPrompt(pendingInput, locale);
        this.store.updatePendingUserInputMessage(pendingInput.localId, messageId);
        this.updateStatus();
        return;
      }
      default: {
        await this.app.respondError(request.id, `Unsupported server request: ${request.method}`);
      }
    }
  }

  private async createBinding(scopeId: string, requestedCwd: string | null): Promise<ThreadBinding> {
    const cwd = requestedCwd || this.config.defaultCwd;
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    const session = await this.app.startThread({
      cwd,
      approvalPolicy: access.approvalPolicy,
      sandboxMode: access.sandboxMode,
      model: settings?.model ?? null,
    });
    return this.storeThreadSession(scopeId, session, 'seed');
  }

  private async startTurnWithRecovery(
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    input: TurnInput[],
    options: {
      developerInstructions?: string | null;
      accessOverride?: { approvalPolicy: string; sandboxMode: SandboxModeValue };
      collaborationModeOverride?: CollaborationModeValue | null;
    } = {},
  ): Promise<{ threadId: string; turnId: string }> {
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    const turnConfig = await this.resolveTurnConfiguration(scopeId, settings, options.collaborationModeOverride);
    const effectiveAccess = options.accessOverride ?? access;
    try {
      const turn = await this.app.startTurn({
        threadId: binding.threadId,
        input,
        approvalPolicy: effectiveAccess.approvalPolicy,
        sandboxMode: effectiveAccess.sandboxMode,
        cwd: binding.cwd ?? this.config.defaultCwd,
        model: turnConfig.model,
        effort: turnConfig.effort,
        collaborationMode: turnConfig.collaborationMode,
        developerInstructions: options.developerInstructions ?? null,
      });
      return { threadId: binding.threadId, turnId: turn.id };
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      this.logger.warn('codex.turn_thread_not_found', { scopeId, threadId: binding.threadId });
      const replacement = await this.createBinding(scopeId, binding.cwd ?? this.config.defaultCwd);
      await this.sendMessage(scopeId, t(this.localeForChat(scopeId), 'current_thread_unavailable_continued', { threadId: replacement.threadId }));
      const nextSettings = this.store.getChatSettings(scopeId);
      const nextAccess = this.resolveEffectiveAccess(scopeId, nextSettings);
      const nextTurnConfig = await this.resolveTurnConfiguration(scopeId, nextSettings, options.collaborationModeOverride);
      const fallbackAccess = options.accessOverride ?? nextAccess;
      const turn = await this.app.startTurn({
        threadId: replacement.threadId,
        input,
        approvalPolicy: fallbackAccess.approvalPolicy,
        sandboxMode: fallbackAccess.sandboxMode,
        cwd: replacement.cwd ?? this.config.defaultCwd,
        model: nextTurnConfig.model,
        effort: nextTurnConfig.effort,
        collaborationMode: nextTurnConfig.collaborationMode,
        developerInstructions: options.developerInstructions ?? null,
      });
      return { threadId: replacement.threadId, turnId: turn.id };
    }
  }

  private async buildTurnInput(
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    event: TelegramTextEvent,
    locale: AppLocale,
  ): Promise<TurnInput[]> {
    if (event.attachments.length === 0) {
      return [{
        type: 'text',
        text: event.text,
        text_elements: [],
      }];
    }

    const cwd = binding.cwd ?? this.config.defaultCwd;
    const stagedAttachments = await this.stageAttachments(cwd, binding.threadId, event.attachments, locale);
    const prompt = buildAttachmentPrompt(event.text, stagedAttachments);
    const input: TurnInput[] = [{
      type: 'text',
      text: prompt,
      text_elements: [],
    }];
    for (const attachment of stagedAttachments) {
      if (!attachment.nativeImage) continue;
      input.push({
        type: 'localImage',
        path: attachment.localPath,
      });
    }
    return input;
  }

  private resolveActiveTurnBinding(scopeId: string, active: ActiveTurn): ThreadBinding {
    const binding = this.store.getBinding(scopeId);
    if (binding?.threadId === active.threadId) {
      return binding;
    }
    return {
      chatId: scopeId,
      threadId: active.threadId,
      cwd: binding?.cwd ?? this.config.defaultCwd,
      updatedAt: Date.now(),
    };
  }

  private async startIncomingTurn(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    binding: ThreadBinding,
    input: TurnInput[],
    options: { queuedInputId?: string | null } = {},
  ): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const requiresPlanConfirmation = this.shouldRequirePlanConfirmation(scopeId, settings);
    const turnState = await this.startTurnWithRecovery(
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
      guidedPlanSessionId = this.createGuidedPlanSession(scopeId, turnState.threadId, turnState.turnId);
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
      options.queuedInputId ? 'queue.start' : 'telegram.turn_start',
    );
  }

  private launchRegisteredTurn(
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
    } = {},
    errorSource = 'telegram.turn_start',
  ): void {
    void this.registerActiveTurn(
      scopeId,
      chatId,
      chatType,
      topicId,
      threadId,
      turnId,
      previewMessageId,
      options,
    ).catch((error) => {
      void this.handleAsyncError(errorSource, error, scopeId);
    });
  }

  private async enqueueTurnInput(
    binding: ThreadBinding,
    event: TelegramTextEvent,
    locale: AppLocale,
  ): Promise<void> {
    const input = await this.buildTurnInput(binding, event, locale);
    const queueId = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const sourceSummary = summarizeTelegramInput(event.text, event.attachments) || t(locale, 'queue_item_summary_fallback');
    this.store.saveQueuedTurnInput({
      queueId,
      scopeId: event.scopeId,
      chatId: event.chatId,
      threadId: binding.threadId,
      input,
      sourceSummary,
      telegramMessageId: null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });
    const queueDepth = this.store.countQueuedTurnInputs(event.scopeId);
    await this.syncGuidedPlanQueueDepth(event.scopeId, queueDepth);
    const receiptMessageId = await this.sendMessage(
      event.scopeId,
      renderQueuedTurnReceiptMessage(locale, queueDepth - 1),
    );
    const current = this.store.getQueuedTurnInput(queueId);
    if (current) {
      this.store.saveQueuedTurnInput({
        ...current,
        telegramMessageId: receiptMessageId,
        updatedAt: Date.now(),
      });
    }
    this.updateStatus();
  }

  private listQueuedTurnInputs(scopeId: string): QueuedTurnInputRecord[] {
    return this.store.listQueuedTurnInputs(scopeId).filter((record) => record.status === 'queued');
  }

  private async syncGuidedPlanQueueDepth(scopeId: string, queueDepth = this.store.countQueuedTurnInputs(scopeId)): Promise<void> {
    for (const session of this.store.listOpenPlanSessions(scopeId)) {
      if (session.queueDepth === queueDepth) {
        continue;
      }
      this.updatePlanSession(session.sessionId, { queueDepth });
    }
    const active = this.findActiveTurn(scopeId);
    if (active) {
      await this.queueTurnRender(active, { forceStatus: true });
    }
    this.updateStatus();
  }

  private async maybeStartQueuedTurn(scopeId: string): Promise<boolean> {
    if (this.findActiveTurn(scopeId)) {
      return false;
    }
    if (this.store.listPendingApprovals(scopeId).length > 0) {
      return false;
    }
    if (this.store.getPendingUserInputForChat(scopeId)) {
      return false;
    }
    if (this.store.listOpenPlanSessions(scopeId).some((session) => session.state === 'awaiting_plan_confirmation' || session.state === 'recovery_required')) {
      return false;
    }
    while (true) {
      const record = this.store.peekQueuedTurnInput(scopeId);
      if (!record) {
        await this.syncGuidedPlanQueueDepth(scopeId, 0);
        return false;
      }
      const started = await this.startQueuedTurn(record);
      if (started) {
        return true;
      }
    }
  }

  private async startQueuedTurn(record: QueuedTurnInputRecord): Promise<boolean> {
    const locale = this.localeForChat(record.scopeId);
    this.store.updateQueuedTurnInputStatus(record.queueId, 'processing');
    await this.syncGuidedPlanQueueDepth(record.scopeId);
    try {
      const binding = await this.ensureThreadReady(record.scopeId, {
        chatId: record.scopeId,
        threadId: record.threadId,
        cwd: this.store.getBinding(record.scopeId)?.cwd ?? this.config.defaultCwd,
        updatedAt: Date.now(),
      });
      await this.sendTyping(record.scopeId);
      const target = parseTelegramScopeId(record.scopeId);
      await this.startIncomingTurn(
        record.scopeId,
        target.chatId,
        inferTelegramChatType(target.chatId),
        target.topicId,
        binding,
        record.input as TurnInput[],
        { queuedInputId: record.queueId },
      );
      return true;
    } catch (error) {
      this.store.updateQueuedTurnInputStatus(record.queueId, 'failed');
      await this.syncGuidedPlanQueueDepth(record.scopeId);
      await this.sendMessage(record.scopeId, t(locale, 'queue_start_failed', { error: formatUserError(error) }));
      this.logger.warn('queue.start_failed', {
        scopeId: record.scopeId,
        queueId: record.queueId,
        error: String(error),
      });
      return false;
    }
  }

  private cancelQueuedTurnInputs(scopeId: string, mode: 'next' | 'clear'): number {
    const queued = this.listQueuedTurnInputs(scopeId);
    const targets = mode === 'next' ? queued.slice(0, 1) : queued;
    for (const record of targets) {
      this.store.updateQueuedTurnInputStatus(record.queueId, 'cancelled');
    }
    return targets.length;
  }

  private async handleQueueCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const action = args.join(' ').trim().toLowerCase();
    if (!action) {
      await this.showQueuePanel(event.scopeId, undefined, locale);
      return;
    }
    if (action !== 'next' && action !== 'clear') {
      await this.sendMessage(event.scopeId, t(locale, 'usage_queue'));
      return;
    }
    const count = this.cancelQueuedTurnInputs(event.scopeId, action);
    await this.syncGuidedPlanQueueDepth(event.scopeId);
    await this.sendMessage(
      event.scopeId,
      t(locale, action === 'next' ? 'queue_cancel_next_result' : 'queue_clear_result', { value: count }),
    );
  }

  private async handleQueueCallback(
    event: TelegramCallbackEvent,
    action: 'next' | 'clear',
    locale: AppLocale,
  ): Promise<void> {
    const count = this.cancelQueuedTurnInputs(event.scopeId, action);
    await this.syncGuidedPlanQueueDepth(event.scopeId);
    await this.showQueuePanel(event.scopeId, event.messageId, locale);
    await this.bot.answerCallback(
      event.callbackQueryId,
      t(locale, action === 'next' ? 'queue_cancel_next_result_short' : 'queue_clear_result_short', { value: count }),
    );
  }

  private async showQueuePanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const queued = this.listQueuedTurnInputs(scopeId);
    const text = renderQueueStatusMessage(locale, {
      activeTurnId: this.findActiveTurn(scopeId)?.turnId ?? null,
      queueDepth: queued.length,
      items: queued,
    });
    const keyboard = queued.length > 0 ? queueControlKeyboard(locale) : [];
    if (messageId !== undefined) {
      await this.editMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendMessage(scopeId, text, keyboard);
  }

  private async recoverPersistentState(): Promise<void> {
    await this.recoverPlanSessions();
    await this.recoverPendingApprovals();
    await this.recoverPendingUserInputs();
    const scopeIds = this.store.listQueuedTurnInputs()
      .filter((record) => record.status === 'queued')
      .map((record) => record.scopeId)
      .filter((scopeId, index, values) => values.indexOf(scopeId) === index);
    for (const scopeId of scopeIds) {
      await this.withLock(scopeId, async () => {
        await this.maybeStartQueuedTurn(scopeId);
      });
    }
  }

  private async recoverPlanSessions(): Promise<void> {
    for (const session of this.store.listOpenPlanSessions()) {
      const locale = this.localeForChat(session.chatId);
      if (session.state === 'awaiting_plan_confirmation') {
        const rendered = renderPlanConfirmationMessage(locale, session);
        const messageId = await this.upsertPlanConfirmationPrompt(session, rendered);
        this.updatePlanSession(session.sessionId, { lastPromptMessageId: messageId });
        continue;
      }
      const nextSession = session.state === 'recovery_required'
        ? session
        : this.updatePlanSession(session.sessionId, {
            state: 'recovery_required',
            currentPromptId: crypto.randomBytes(6).toString('hex'),
          });
      if (!nextSession) {
        continue;
      }
      const latestSnapshot = this.store.listPlanSnapshots(nextSession.sessionId).at(-1) ?? null;
      const rendered = renderPlanRecoveryMessage(locale, nextSession, latestSnapshot);
      const messageId = await this.upsertPlanConfirmationPrompt(nextSession, rendered);
      this.updatePlanSession(nextSession.sessionId, { lastPromptMessageId: messageId });
    }
  }

  private async recoverPendingApprovals(): Promise<void> {
    for (const approval of this.store.listPendingApprovals()) {
      const locale = this.localeForChat(approval.chatId);
      const messageId = await this.sendMessage(
        approval.chatId,
        renderApprovalMessage(locale, approval),
        approvalKeyboard(locale, approval.localId),
      );
      this.store.updatePendingApprovalMessage(approval.localId, messageId);
      this.armApprovalTimer(approval.localId);
    }
  }

  private async recoverPendingUserInputs(): Promise<void> {
    for (const pendingInput of this.store.listPendingUserInputs()) {
      const locale = this.localeForChat(pendingInput.chatId);
      const messageId = await this.openPendingUserInputPrompt(pendingInput, locale);
      this.store.updatePendingUserInputMessage(pendingInput.localId, messageId);
    }
  }

  private async handlePlanRecoveryCallback(
    event: TelegramCallbackEvent,
    sessionId: string,
    action: PlanRecoveryAction,
    locale: AppLocale,
  ): Promise<void> {
    const session = this.store.getPlanSession(sessionId);
    if (!session) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_resolved'));
      return;
    }
    if (session.chatId !== event.scopeId || (session.lastPromptMessageId !== null && session.lastPromptMessageId !== event.messageId)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_confirmation_mismatch'));
      return;
    }
    if (session.state !== 'recovery_required') {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_resolved'));
      return;
    }
    if (action === 'show') {
      const latestSnapshot = this.store.listPlanSnapshots(sessionId).at(-1) ?? null;
      if (!latestSnapshot) {
        await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_no_snapshot'));
        return;
      }
      await this.sendHtmlMessage(event.scopeId, renderRecoveredPlanSnapshotMessage(locale, session, latestSnapshot));
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_showing_snapshot'));
      return;
    }
    if (action === 'cancel') {
      const cancelled = this.updatePlanSession(sessionId, {
        state: 'cancelled',
        currentPromptId: null,
        resolvedAt: Date.now(),
      });
      if (cancelled && cancelled.lastPromptMessageId !== null) {
        await this.editHtmlMessage(
          cancelled.chatId,
          cancelled.lastPromptMessageId,
          renderResolvedPlanRecoveryMessage(locale, cancelled, action),
          [],
        );
      }
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_cancelled'));
      await this.maybeStartQueuedTurn(event.scopeId);
      return;
    }
    if (this.findActiveTurn(event.scopeId)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
      return;
    }
    const binding = await this.resolvePlanSessionBinding(event.scopeId, session.threadId);
    const continuingConfirmedPlan = session.confirmedPlanVersion !== null;
    await this.sendTyping(event.scopeId);
    const turnState = await this.startTurnWithRecovery(
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
    const nextSession = this.updatePlanSession(sessionId, {
      threadId: turnState.threadId,
      sourceTurnId: continuingConfirmedPlan ? session.sourceTurnId : turnState.turnId,
      executionTurnId: continuingConfirmedPlan ? turnState.turnId : null,
      state: continuingConfirmedPlan ? 'executing_confirmed_plan' : 'drafting_plan',
      currentPromptId: null,
      resolvedAt: null,
    });
    if (session.lastPromptMessageId !== null && nextSession) {
      await this.editHtmlMessage(
        session.chatId,
        session.lastPromptMessageId,
        renderResolvedPlanRecoveryMessage(locale, nextSession, action),
        [],
      );
    }
    this.launchRegisteredTurn(
      event.scopeId,
      event.chatId,
      inferTelegramChatType(event.chatId),
      event.topicId,
      turnState.threadId,
      turnState.turnId,
      0,
      {
        guidedPlanSessionId: sessionId,
        guidedPlanDraftOnly: !continuingConfirmedPlan,
      },
      'plan.recovery_start',
    );
    await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_recovery_continuing'));
  }

  private async stageAttachments(
    cwd: string,
    threadId: string,
    attachments: readonly TelegramInboundAttachment[],
    locale: AppLocale,
  ): Promise<StagedTelegramAttachment[]> {
    const staged: StagedTelegramAttachment[] = [];
    for (const attachment of attachments) {
      try {
        const remoteFile = await this.bot.getFile(attachment.fileId);
        const resolvedSize = attachment.fileSize ?? remoteFile.file_size ?? null;
        if (resolvedSize !== null && resolvedSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES) {
          throw new UserFacingError(t(locale, 'attachment_too_large', {
            name: attachment.fileName ?? attachment.fileUniqueId,
            size: resolvedSize,
          }));
        }
        if (!remoteFile.file_path) {
          throw new Error('Telegram file path is missing');
        }
        const planned = planAttachmentStoragePath(cwd, threadId, attachment, remoteFile.file_path);
        await fs.mkdir(path.dirname(planned.localPath), { recursive: true });
        await this.bot.downloadResolvedFile(remoteFile.file_path, planned.localPath);
        const resolvedAttachment: TelegramInboundAttachment = {
          ...attachment,
          fileName: planned.fileName,
          fileSize: resolvedSize,
        };
        staged.push({
          ...resolvedAttachment,
          fileName: planned.fileName,
          localPath: planned.localPath,
          relativePath: planned.relativePath,
          nativeImage: isNativeImageAttachment(resolvedAttachment),
        });
      } catch (error) {
        if (error instanceof UserFacingError) {
          throw error;
        }
        throw new Error(t(locale, 'attachment_download_failed', {
          name: attachment.fileName ?? attachment.fileUniqueId,
          error: formatUserError(error),
        }));
      }
    }
    return staged;
  }

  private async registerActiveTurn(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    threadId: string,
    turnId: string,
    previewMessageId: number,
    options: { guidedPlanSessionId?: string | null; guidedPlanDraftOnly?: boolean; queuedInputId?: string | null } = {},
  ): Promise<void> {
    let resolveTurn!: () => void;
    const waitForTurn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const active: ActiveTurn = {
      scopeId,
      chatId,
      topicId,
      renderRoute: resolveTelegramRenderRoute(chatType, topicId),
      threadId,
      turnId,
      queuedInputId: options.queuedInputId ?? null,
      previewMessageId,
      previewActive: previewMessageId > 0,
      draftId: null,
      draftText: null,
      buffer: '',
      finalText: null,
      interruptRequested: false,
      statusMessageText: null,
      statusNeedsRebase: false,
      segments: [],
      reasoningActiveCount: 0,
      pendingApprovalKinds: new Set(),
      pendingUserInputId: null,
      toolBatch: null,
      pendingArchivedStatus: null,
      planMessageId: null,
      planText: null,
      planExplanation: null,
      planSteps: [],
      planDraftText: null,
      planLastRenderedAt: 0,
      planRenderRequested: false,
      forcePlanRender: false,
      planRenderTask: null,
      guidedPlanSessionId: options.guidedPlanSessionId ?? null,
      guidedPlanDraftOnly: Boolean(options.guidedPlanDraftOnly),
      guidedPlanExecutionBlocked: false,
      renderRetryTimer: null,
      lastStreamFlushAt: 0,
      renderRequested: false,
      forceStatusFlush: false,
      forceStreamFlush: false,
      renderTask: null,
      resolver: resolveTurn,
    };
    this.activeTurns.set(turnId, active);
    if (previewMessageId > 0) {
      this.store.saveActiveTurnPreview({
        turnId,
        scopeId,
        threadId,
        messageId: previewMessageId,
      });
    }
    this.updateStatus();
    try {
      await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    } catch (error) {
      this.logger.warn('telegram.preview_keyboard_attach_failed', { error: String(error), turnId });
    }
    await waitForTurn;
  }

  private async completeTurn(active: ActiveTurn): Promise<void> {
    const locale = this.localeForChat(active.scopeId);
    let shouldMarkPartialOutput = false;
    try {
      await this.renderPlanCard(active);
      await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
      const renderedMessages = active.segments.reduce((count, segment) => count + segment.messages.length, 0);
      if (renderedMessages === 0) {
        const fallbackKey = active.interruptRequested ? 'interrupted' : 'completed';
        const finalChunks = chunkTelegramMessage(active.finalText || active.buffer, undefined, t(locale, fallbackKey));
        for (const chunk of finalChunks) {
          await this.sendMessage(active.scopeId, chunk);
        }
      }
      shouldMarkPartialOutput = active.interruptRequested
        && (renderedMessages > 0 || Boolean((active.finalText || active.buffer).trim()));
    } finally {
      this.clearRenderRetry(active);
      await this.cleanupFinishedPreview(active, locale);
    }
    if (shouldMarkPartialOutput) {
      await this.sendMessage(active.scopeId, t(locale, 'interrupted_partial_output'));
    }
    if (active.queuedInputId) {
      this.store.updateQueuedTurnInputStatus(active.queuedInputId, 'completed');
      await this.syncGuidedPlanQueueDepth(active.scopeId);
    }
  }

  private async finalizeGuidedPlanTurn(active: ActiveTurn): Promise<void> {
    if (!active.guidedPlanSessionId) {
      return;
    }
    const session = this.store.getPlanSession(active.guidedPlanSessionId);
    if (!session) {
      return;
    }
    if (active.guidedPlanDraftOnly) {
      await this.finalizeGuidedPlanDraftTurn(active, session);
      return;
    }
    const terminalState = active.interruptRequested ? 'interrupted' : 'completed';
    this.updatePlanSession(session.sessionId, {
      state: terminalState,
      currentPromptId: null,
      executionTurnId: active.turnId,
      resolvedAt: Date.now(),
    });
    this.updateStatus();
  }

  private async finalizeGuidedPlanDraftTurn(active: ActiveTurn, session: GuidedPlanSession): Promise<void> {
    if (active.interruptRequested && !active.guidedPlanExecutionBlocked) {
      this.updatePlanSession(session.sessionId, {
        state: 'interrupted',
        currentPromptId: null,
        resolvedAt: Date.now(),
      });
      await this.sendMessage(active.scopeId, t(this.localeForChat(active.scopeId), 'plan_draft_interrupted'));
      this.updateStatus();
      return;
    }
    const nextSession = this.updatePlanSession(session.sessionId, {
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
    const locale = this.localeForChat(active.scopeId);
    const rendered = renderPlanConfirmationMessage(locale, nextSession, {
      blockedExecution: active.guidedPlanExecutionBlocked,
    });
    const promptMessageId = await this.upsertPlanConfirmationPrompt(nextSession, rendered);
    this.updatePlanSession(session.sessionId, {
      lastPromptMessageId: promptMessageId,
    });
    this.updateStatus();
  }

  private async upsertPlanConfirmationPrompt(
    session: GuidedPlanSession,
    rendered: { html: string; keyboard: Array<Array<{ text: string; callback_data: string }>> },
  ): Promise<number> {
    if (session.lastPromptMessageId !== null) {
      try {
        await this.editHtmlMessage(session.chatId, session.lastPromptMessageId, rendered.html, rendered.keyboard);
        return session.lastPromptMessageId;
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          throw error;
        }
      }
    }
    return this.sendHtmlMessage(session.chatId, rendered.html, rendered.keyboard);
  }

  private async queuePlanRender(active: ActiveTurn, force = false): Promise<void> {
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
        if (!this.activeTurns.has(active.turnId)) {
          return;
        }
        await this.renderPlanCard(active);
      }
    })().finally(() => {
      active.planRenderTask = null;
    });
    await active.planRenderTask;
  }

  private async renderPlanCard(active: ActiveTurn): Promise<void> {
    const session = active.guidedPlanSessionId ? this.store.getPlanSession(active.guidedPlanSessionId) : null;
    const hasStructuredPlan = active.planSteps.length > 0 || Boolean(active.planExplanation);
    const hasDraftText = Boolean(active.planDraftText?.trim());
    if (!hasStructuredPlan && !hasDraftText) {
      return;
    }
    const locale = this.localeForChat(active.scopeId);
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
        await this.editHtmlMessage(active.scopeId, existingMessageId, html, []);
        active.planMessageId = existingMessageId;
        active.planText = html;
        active.planLastRenderedAt = Date.now();
        if (session) {
          this.updatePlanSession(session.sessionId, {
            lastPlanMessageId: existingMessageId,
          });
        }
        return;
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.plan_update_edit_failed', {
            turnId: active.turnId,
            messageId: existingMessageId,
            error: String(error),
          });
        }
      }
    }
    const messageId = await this.sendHtmlMessage(active.scopeId, html);
    active.planMessageId = messageId;
    active.planText = html;
    active.planLastRenderedAt = Date.now();
    if (session) {
      this.updatePlanSession(session.sessionId, {
        lastPlanMessageId: messageId,
      });
    }
  }

  private async handleTurnActivityEvent(activity: TurnActivityEvent): Promise<void> {
    const active = this.activeTurns.get(activity.turnId);
    if (!active) {
      return;
    }

    switch (activity.kind) {
      case 'agent_message_started': {
        this.promoteReadyToolBatch(active);
        ensureTurnSegment(active, activity.itemId, activity.phase, activity.outputKind);
        await this.queueTurnRender(active, { forceStatus: true });
        return;
      }
      case 'agent_message_delta': {
        const segment = ensureTurnSegment(active, activity.itemId, undefined, activity.outputKind);
        segment.text += activity.delta;
        active.buffer += activity.delta;
        await this.queueTurnRender(active);
        return;
      }
      case 'agent_message_completed': {
        const segment = ensureTurnSegment(active, activity.itemId, activity.phase, activity.outputKind);
        if (activity.text !== null) {
          segment.text = activity.text || segment.text;
          if (activity.outputKind === 'final_answer') {
            active.finalText = activity.text || active.buffer || t(this.localeForChat(active.scopeId), 'completed');
          }
        }
        segment.completed = true;
        await this.queueTurnRender(active, { forceStream: true, forceStatus: true });
        return;
      }
      case 'reasoning_started': {
        this.promoteReadyToolBatch(active);
        active.reasoningActiveCount += 1;
        await this.queueTurnRender(active, { forceStatus: true });
        return;
      }
      case 'reasoning_completed': {
        active.reasoningActiveCount = Math.max(0, active.reasoningActiveCount - 1);
        await this.queueTurnRender(active, { forceStatus: true });
        return;
      }
      case 'tool_started': {
        this.noteToolCommandStart(active, activity.exec);
        await this.queueTurnRender(active, { forceStatus: true });
        return;
      }
      case 'tool_completed': {
        this.noteToolCommandEnd(active, activity.exec);
        await this.queueTurnRender(active, { forceStatus: true });
        return;
      }
      case 'turn_completed': {
        try {
          this.promoteReadyToolBatch(active);
          await this.completeTurn(active);
          await this.finalizeGuidedPlanTurn(active);
          if (this.config.codexAppSyncOnTurnComplete) {
            const revealError = await this.tryRevealThread(active.scopeId, active.threadId, 'turn-complete');
            if (revealError) {
              this.logger.warn('codex.reveal_thread_failed', {
                scopeId: active.scopeId,
                threadId: active.threadId,
                reason: 'turn-complete',
                error: revealError,
              });
            }
          }
        } finally {
          active.resolver();
          this.activeTurns.delete(active.turnId);
          this.updateStatus();
          void this.withLock(active.scopeId, async () => {
            await this.maybeStartQueuedTurn(active.scopeId);
          }).catch((error) => {
            void this.handleAsyncError('queue.autostart', error, active.scopeId);
          });
        }
        return;
      }
    }
  }

  private createApprovalRecord(kind: PendingApprovalRecord['kind'], serverRequestId: string | number, params: any): PendingApprovalRecord {
    const threadId = String(params.threadId);
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId) {
      throw new Error(`No chat binding found for thread ${threadId}`);
    }
    const details = deriveApprovalDetails(kind, params);
    const record: PendingApprovalRecord = {
      localId: crypto.randomBytes(8).toString('hex'),
      serverRequestId: String(serverRequestId),
      kind,
      chatId: scopeId,
      threadId,
      turnId: String(params.turnId),
      itemId: String(params.itemId),
      approvalId: params.approvalId ? String(params.approvalId) : null,
      reason: params.reason ? String(params.reason) : null,
      command: typeof params.command === 'string'
        ? params.command
        : Array.isArray(params.command)
          ? params.command.map((part: unknown) => String(part)).join(' ')
          : null,
      cwd: params.cwd ? String(params.cwd) : null,
      summary: details.summary,
      riskLevel: details.riskLevel,
      details: details.details,
      messageId: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.store.savePendingApproval(record);
    return record;
  }

  private createPendingUserInputRecord(serverRequestId: string | number, params: any): PendingUserInputRecord {
    const threadId = String(params.threadId);
    const scopeId = this.findChatByThread(threadId);
    if (!scopeId) {
      throw new Error(`No chat binding found for thread ${threadId}`);
    }
    const questions = Array.isArray(params.questions)
      ? params.questions.map((question: any): PendingUserInputQuestion => {
          const options = Array.isArray(question.options)
            ? question.options
              .map((option: any) => ({
                label: String(option.label || ''),
                description: String(option.description || ''),
              }))
              .filter((option: { label: string }) => option.label.trim())
            : [];
          return {
            id: String(question.id),
            header: String(question.header || question.id || 'Question'),
            question: String(question.question || ''),
            isOther: Boolean(question.isOther),
            isSecret: Boolean(question.isSecret),
            options: options.length > 0 ? options : null,
          };
        })
      : [];
    const record: PendingUserInputRecord = {
      localId: crypto.randomBytes(8).toString('hex'),
      serverRequestId: String(serverRequestId),
      chatId: scopeId,
      threadId,
      turnId: String(params.turnId),
      itemId: String(params.itemId),
      messageId: null,
      questions,
      answers: {},
      currentQuestionIndex: 0,
      awaitingFreeText: false,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.store.savePendingUserInput(record);
    return record;
  }

  private async rejectDraftOnlyApprovalRequestIfNeeded(serverRequestId: string | number, params: any): Promise<boolean> {
    const turnId = typeof params?.turnId === 'string' ? params.turnId : String(params?.turnId || '');
    if (!turnId) {
      return false;
    }
    const active = this.activeTurns.get(turnId);
    if (!active?.guidedPlanDraftOnly) {
      return false;
    }
    active.guidedPlanExecutionBlocked = true;
    await this.app.respond(serverRequestId, { decision: 'decline' });
    await this.sendMessage(active.scopeId, t(this.localeForChat(active.scopeId), 'plan_draft_execution_blocked'));
    if (!active.interruptRequested) {
      try {
        await this.requestInterrupt(active);
      } catch (error) {
        this.logger.warn('guided_plan.draft_interrupt_failed', {
          turnId: active.turnId,
          error: String(error),
        });
      }
    }
    return true;
  }

  private findChatByThread(threadId: string): string | null {
    for (const turn of this.activeTurns.values()) {
      if (turn.threadId === threadId) return turn.scopeId;
    }
    return this.store.findChatIdByThreadId(threadId);
  }

  private withLock(scopeId: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(scopeId) || Promise.resolve();
    const next = previous.then(fn, fn).finally(() => {
      if (this.locks.get(scopeId) === next) {
        this.locks.delete(scopeId);
      }
    });
    this.locks.set(scopeId, next);
    return next;
  }

  private updateStatus(): void {
    writeRuntimeStatus(this.config.statusPath, this.getRuntimeStatus());
  }

  private async sendMessage(
    scopeId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number> {
    const target = parseTelegramScopeId(scopeId);
    return this.bot.sendMessage(target.chatId, text, inlineKeyboard, target.topicId);
  }

  private async sendHtmlMessage(
    scopeId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number> {
    const target = parseTelegramScopeId(scopeId);
    return this.bot.sendHtmlMessage(target.chatId, text, inlineKeyboard, target.topicId);
  }

  private async editMessage(
    scopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.editMessage(target.chatId, messageId, text, inlineKeyboard);
  }

  private async editHtmlMessage(
    scopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.editHtmlMessage(target.chatId, messageId, text, inlineKeyboard);
  }

  private async deleteMessage(scopeId: string, messageId: number): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.deleteMessage(target.chatId, messageId);
  }

  private async sendTyping(scopeId: string): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.sendTypingInThread(target.chatId, target.topicId);
  }

  private async ensureThreadReady(scopeId: string, binding: ThreadBinding): Promise<ThreadBinding> {
    if (this.attachedThreads.has(binding.threadId)) {
      return binding;
    }
    try {
      const session = await this.app.resumeThread({ threadId: binding.threadId });
      return this.storeThreadSession(scopeId, session, 'seed');
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      this.logger.warn('codex.thread_binding_stale', { scopeId, threadId: binding.threadId });
      const replacement = await this.createBinding(scopeId, binding.cwd ?? this.config.defaultCwd);
      await this.sendMessage(scopeId, t(this.localeForChat(scopeId), 'previous_thread_unavailable_started', { threadId: replacement.threadId }));
      return {
        chatId: scopeId,
        threadId: replacement.threadId,
        cwd: replacement.cwd,
        updatedAt: Date.now(),
      };
    }
  }

  private async handleAsyncError(source: string, error: unknown, scopeId?: string): Promise<void> {
    this.lastError = formatUserError(error);
    this.logger.error(`${source}.failed`, { error: toErrorMeta(error), scopeId: scopeId ?? null });
    this.updateStatus();
    if (!scopeId) return;
    try {
      await this.sendMessage(scopeId, t(this.localeForChat(scopeId), 'bridge_error', { error: formatUserError(error) }));
    } catch (notifyError) {
      this.logger.error('telegram.error_notification_failed', { error: toErrorMeta(notifyError), scopeId });
    }
  }

  private armApprovalTimer(localId: string): void {
    this.clearApprovalTimer(localId);
    const timer = setTimeout(() => {
      void this.expireApproval(localId);
    }, 5 * 60 * 1000);
    this.approvalTimers.set(localId, timer);
  }

  private clearApprovalTimer(localId: string): void {
    const timer = this.approvalTimers.get(localId);
    if (!timer) return;
    clearTimeout(timer);
    this.approvalTimers.delete(localId);
  }

  private async expireApproval(localId: string): Promise<void> {
    const approval = this.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      this.clearApprovalTimer(localId);
      return;
    }
    try {
      await this.app.respond(approval.serverRequestId, { decision: 'decline' });
      this.store.markApprovalResolved(localId);
      await this.clearPendingApprovalStatus(approval.threadId, approval.kind);
      const locale = this.localeForChat(approval.chatId);
      if (approval.messageId !== null) {
        await this.editMessage(approval.chatId, approval.messageId, renderApprovalMessage(locale, approval, 'deny'));
      } else {
        await this.sendMessage(approval.chatId, t(locale, 'approval_timed_out_denied', { threadId: approval.threadId }));
      }
    } catch (error) {
      this.lastError = String(error);
      this.logger.error('approval.timeout_failed', { localId, error: String(error) });
    } finally {
      this.clearApprovalTimer(localId);
      this.updateStatus();
    }
  }

  private async tryRevealThread(scopeId: string, threadId: string, reason: 'open' | 'reveal' | 'turn-complete'): Promise<string | null> {
    try {
      await this.app.revealThread(threadId);
      this.store.insertAudit('outbound', scopeId, 'codex.app.reveal', `${reason}:${threadId}`);
      return null;
    } catch (error) {
      return formatUserError(error);
    }
  }

  private async bindCachedThread(scopeId: string, threadId: string): Promise<ThreadBinding> {
    const session = await this.app.resumeThread({ threadId });
    return this.storeThreadSession(scopeId, session, 'replace');
  }

  private storeThreadSession(scopeId: string, session: ThreadSessionState, syncMode: 'replace' | 'seed'): ThreadBinding {
    const existing = this.store.getChatSettings(scopeId);
    const hasExisting = existing !== null;
    const model = syncMode === 'seed'
      ? hasExisting ? existing.model : session.model
      : session.model;
    const effort = syncMode === 'seed'
      ? hasExisting ? existing.reasoningEffort : session.reasoningEffort
      : session.reasoningEffort;
    const normalized: ThreadBinding = {
      chatId: scopeId,
      threadId: session.thread.threadId,
      cwd: session.cwd,
      updatedAt: Date.now(),
    };
    this.store.setBinding(scopeId, normalized.threadId, normalized.cwd);
    this.store.setChatSettings(scopeId, model, effort);
    this.attachedThreads.add(normalized.threadId);
    this.updateStatus();
    return normalized;
  }

  private async resolveTurnConfiguration(
    scopeId: string,
    settings = this.store.getChatSettings(scopeId),
    collaborationModeOverride?: CollaborationModeValue | null,
  ): Promise<{ model: string | null; effort: ReasoningEffortValue | null; collaborationMode: CollaborationModeValue | null }> {
    let model = settings?.model ?? null;
    const effort = settings?.reasoningEffort ?? null;
    const collaborationMode = collaborationModeOverride === undefined
      ? settings?.collaborationMode ?? null
      : collaborationModeOverride;
    if (collaborationMode === 'plan' && !model) {
      const models = await this.app.listModels();
      model = resolveCurrentModel(models, null)?.model ?? null;
    }
    return { model, effort, collaborationMode };
  }

  private resolveEffectiveAccess(scopeId: string, settings = this.store.getChatSettings(scopeId)) {
    return resolveAccessMode(this.config, settings);
  }

  private localeForChat(scopeId: string, languageCode?: string | null): AppLocale {
    if (languageCode) {
      const locale = normalizeLocale(languageCode);
      const current = this.store.getChatSettings(scopeId);
      if (current?.locale !== locale) {
        this.store.setChatLocale(scopeId, locale);
      }
      return locale;
    }
    return this.store.getChatSettings(scopeId)?.locale ?? 'en';
  }

  private findActiveTurn(scopeId: string): ActiveTurn | undefined {
    return [...this.activeTurns.values()].find(turn => turn.scopeId === scopeId);
  }

  private shouldRequirePlanConfirmation(
    scopeId: string,
    settings = this.store.getChatSettings(scopeId),
  ): boolean {
    return (settings?.collaborationMode ?? null) === 'plan'
      && (settings?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute);
  }

  private shouldAllowInteractiveUserInput(
    scopeId: string,
    settings = this.store.getChatSettings(scopeId),
  ): boolean {
    return (settings?.collaborationMode ?? null) === 'plan';
  }

  private async clearPendingUserInputsIfNeeded(scopeId: string, locale = this.localeForChat(scopeId)): Promise<void> {
    if (this.shouldAllowInteractiveUserInput(scopeId)) {
      return;
    }
    for (const record of this.store.listPendingUserInputs(scopeId)) {
      await this.cancelPendingUserInput(record, locale);
    }
  }

  private getAwaitingPlanConfirmationSession(scopeId: string): GuidedPlanSession | null {
    return this.store.listOpenPlanSessions(scopeId)
      .find((session) => session.state === 'awaiting_plan_confirmation') ?? null;
  }

  private createGuidedPlanSession(scopeId: string, threadId: string, sourceTurnId: string): string {
    const now = Date.now();
    const sessionId = crypto.randomBytes(8).toString('hex');
    this.store.savePlanSession({
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

  private async resolvePlanSessionBinding(scopeId: string, threadId: string): Promise<ThreadBinding> {
    const existing = this.store.getBinding(scopeId);
    if (existing?.threadId === threadId) {
      return this.ensureThreadReady(scopeId, existing);
    }
    const thread = await this.app.readThread(threadId, false);
    if (!thread) {
      throw new Error(`Thread ${threadId} is unavailable`);
    }
    const cwd = thread.cwd ?? this.config.defaultCwd;
    this.store.setBinding(scopeId, threadId, cwd);
    return {
      chatId: scopeId,
      threadId,
      cwd,
      updatedAt: Date.now(),
    };
  }

  private buildPlanTurnInput(text: string): TurnInput[] {
    return [{
      type: 'text',
      text,
      text_elements: [],
    }];
  }

  private updatePlanSession(
    sessionId: string,
    updates: Partial<GuidedPlanSession>,
  ): GuidedPlanSession | null {
    const current = this.store.getPlanSession(sessionId);
    if (!current) {
      return null;
    }
    const next: GuidedPlanSession = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
    };
    this.store.savePlanSession(next);
    return next;
  }

  private async handlePlanSessionCallback(
    event: TelegramCallbackEvent,
    sessionId: string,
    action: PlanSessionAction,
    locale: AppLocale,
  ): Promise<void> {
    const session = this.store.getPlanSession(sessionId);
    if (!session) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_confirmation_resolved'));
      return;
    }
    if (session.chatId !== event.scopeId || (session.lastPromptMessageId !== null && session.lastPromptMessageId !== event.messageId)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_confirmation_mismatch'));
      return;
    }
    if (session.resolvedAt !== null || session.state === 'cancelled' || session.state === 'completed' || session.state === 'interrupted') {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_confirmation_resolved'));
      return;
    }
    if (session.state !== 'awaiting_plan_confirmation') {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_action_unavailable'));
      return;
    }
    if (this.findActiveTurn(event.scopeId)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
      return;
    }
    if (action === 'cancel') {
      const cancelled = this.updatePlanSession(sessionId, {
        state: 'cancelled',
        currentPromptId: null,
        resolvedAt: Date.now(),
      });
      if (cancelled && cancelled.lastPromptMessageId !== null) {
        await this.editHtmlMessage(
          cancelled.chatId,
          cancelled.lastPromptMessageId,
          renderResolvedPlanConfirmationMessage(locale, cancelled, action),
          [],
        );
      }
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_action_started_cancel'));
      this.updateStatus();
      await this.maybeStartQueuedTurn(event.scopeId);
      return;
    }
    if (action === 'confirm' && session.latestPlanVersion === null) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'plan_action_unavailable'));
      return;
    }

    await this.sendTyping(event.scopeId);
    const binding = await this.resolvePlanSessionBinding(event.scopeId, session.threadId);
    const turnState = await this.startTurnWithRecovery(
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
    const nextSession = this.updatePlanSession(sessionId, {
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
      await this.editHtmlMessage(
        session.chatId,
        session.lastPromptMessageId,
        renderResolvedPlanConfirmationMessage(locale, nextSession, action),
        [],
      );
    }
    this.launchRegisteredTurn(
      event.scopeId,
      event.chatId,
      inferTelegramChatType(event.chatId),
      event.topicId,
      turnState.threadId,
      turnState.turnId,
      0,
      {
        guidedPlanSessionId: sessionId,
        guidedPlanDraftOnly: action === 'revise',
      },
      'plan.session_start',
    );
    await this.bot.answerCallback(
      event.callbackQueryId,
      t(locale, action === 'confirm' ? 'plan_action_started_confirm' : 'plan_action_started_revise'),
    );
  }

  private async handleModeCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    if (args.length === 0) {
      await this.showModeSettingsPanel(scopeId, undefined, locale);
      return;
    }
    const normalized = args.join(' ').trim().toLowerCase();
    const nextMode = normalizeRequestedCollaborationMode(normalized);
    if (!nextMode && normalized !== 'default' && normalized !== 'plan') {
      await this.showModeSettingsPanel(scopeId, undefined, locale);
      return;
    }
    this.store.setChatCollaborationMode(scopeId, nextMode);
    if (nextMode !== 'plan') {
      await this.clearPendingUserInputsIfNeeded(scopeId, locale);
    }
    await this.sendMessage(scopeId, t(locale, 'callback_mode', {
      value: formatCollaborationModeLabel(locale, nextMode),
    }));
  }

  private async handlePlanAliasCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const normalized = args.join(' ').trim().toLowerCase();
    if (!normalized || normalized === 'on' || normalized === 'enable' || normalized === 'enabled') {
      this.store.setChatCollaborationMode(event.scopeId, 'plan');
      await this.sendMessage(event.scopeId, t(locale, 'callback_mode', {
        value: formatCollaborationModeLabel(locale, 'plan'),
      }));
      return;
    }
    if (normalized === 'off' || normalized === 'disable' || normalized === 'disabled' || normalized === 'default') {
      this.store.setChatCollaborationMode(event.scopeId, 'default');
      await this.clearPendingUserInputsIfNeeded(event.scopeId, locale);
      await this.sendMessage(event.scopeId, t(locale, 'callback_mode', {
        value: formatCollaborationModeLabel(locale, 'default'),
      }));
      return;
    }
    await this.showModeSettingsPanel(event.scopeId, undefined, locale);
  }

  private async handleModelCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    if (args.length === 0) {
      await this.showModelSettingsPanel(scopeId, undefined, locale);
      return;
    }

    if (this.findActiveTurn(scopeId)) {
      await this.sendMessage(scopeId, t(locale, 'model_change_blocked'));
      return;
    }
    const settings = this.store.getChatSettings(scopeId);
    const raw = args.join(' ').trim();
    const models = await this.app.listModels();
    if (raw === '' || raw.toLowerCase() === 'default' || raw.toLowerCase() === 'reset') {
      const defaultModel = resolveCurrentModel(models, null);
      const nextEffort = clampEffortToModel(defaultModel, settings?.reasoningEffort ?? null);
      this.store.setChatSettings(scopeId, null, nextEffort.effort);
      const lines = [
        t(locale, 'model_reset'),
        t(locale, 'status_configured_effort', { value: nextEffort.effort ?? t(locale, 'server_default') }),
        t(locale, 'applies_next_turn'),
        t(locale, 'tip_use_models'),
      ];
      if (nextEffort.adjustedFrom) {
        lines.splice(1, 0, t(locale, 'effort_adjusted_default_model', { effort: nextEffort.adjustedFrom }));
      }
      await this.sendMessage(scopeId, lines.join('\n'));
      return;
    }

    const selected = resolveRequestedModel(models, raw);
    if (!selected) {
      await this.sendMessage(scopeId, t(locale, 'unknown_model', { model: raw }));
      return;
    }

    const nextEffort = clampEffortToModel(selected, settings?.reasoningEffort ?? null);
    this.store.setChatSettings(scopeId, selected.model, nextEffort.effort);
    const lines = [
      t(locale, 'model_configured', { model: selected.model }),
      t(locale, 'status_configured_effort', { value: nextEffort.effort ?? t(locale, 'server_default') }),
      t(locale, 'applies_next_turn'),
      t(locale, 'tip_use_models'),
    ];
    if (nextEffort.adjustedFrom) {
      lines.splice(1, 0, t(locale, 'effort_adjusted_model', { effort: nextEffort.adjustedFrom, model: selected.model }));
    }
    await this.sendMessage(scopeId, lines.join('\n'));
  }

  private async handleEffortCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    if (args.length === 0) {
      await this.showModelSettingsPanel(scopeId, undefined, locale);
      return;
    }

    if (this.findActiveTurn(scopeId)) {
      await this.sendMessage(scopeId, t(locale, 'effort_change_blocked'));
      return;
    }
    const settings = this.store.getChatSettings(scopeId);
    const models = await this.app.listModels();
    const currentModel = resolveCurrentModel(models, settings?.model ?? null);
    const raw = args.join(' ').trim().toLowerCase();
    if (raw === 'default' || raw === 'reset') {
      this.store.setChatSettings(scopeId, settings?.model ?? null, null);
      await this.sendMessage(scopeId, [
        t(locale, 'effort_reset'),
        t(locale, 'applies_next_turn'),
        t(locale, 'tip_use_models'),
      ].join('\n'));
      return;
    }

    const effort = normalizeRequestedEffort(raw);
    if (!effort) {
      await this.sendMessage(scopeId, t(locale, 'usage_effort'));
      return;
    }
    if (currentModel && currentModel.supportedReasoningEfforts.length > 0 && !currentModel.supportedReasoningEfforts.includes(effort)) {
      await this.sendMessage(
        scopeId,
        t(locale, 'model_does_not_support_effort', {
          model: currentModel.model,
          effort,
          supported: currentModel.supportedReasoningEfforts.join(', '),
        }),
      );
      return;
    }
    this.store.setChatSettings(scopeId, settings?.model ?? null, effort);
    await this.sendMessage(scopeId, [
      t(locale, 'effort_configured', { effort }),
      t(locale, 'applies_next_turn'),
      t(locale, 'tip_use_models'),
    ].join('\n'));
  }

  private async handleThreadOpenCallback(event: TelegramCallbackEvent, threadId: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    let binding: ThreadBinding;
    try {
      binding = await this.bindCachedThread(scopeId, threadId);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        await this.bot.answerCallback(event.callbackQueryId, t(locale, 'thread_no_longer_available'));
        return;
      }
      throw error;
    }

    const threads = this.store.listCachedThreads(scopeId);
    if (threads.length > 0) {
      await this.editHtmlMessage(
        scopeId,
        event.messageId,
        formatThreadsMessage(locale, threads, binding.threadId),
        buildThreadsKeyboard(locale, threads),
      );
    }

    let callbackText = t(locale, 'thread_opened');
    if (this.config.codexAppSyncOnOpen) {
      const revealError = await this.tryRevealThread(scopeId, binding.threadId, 'open');
      callbackText = revealError ? t(locale, 'opened_sync_failed_short') : t(locale, 'opened_in_codex_short');
    }
    await this.bot.answerCallback(event.callbackQueryId, callbackText);
    await this.renderThreadHistoryPreview(scopeId, binding.threadId, locale);
  }

  private async renderThreadHistoryPreview(scopeId: string, threadId: string, locale: AppLocale): Promise<void> {
    try {
      const thread = await this.app.readThreadWithTurns(threadId);
      if (!thread) {
        return;
      }
      const text = formatThreadHistoryPreviewMessage(
        locale,
        {
          threadId: thread.threadId,
          name: this.store.getThreadNameOverride(scopeId, thread.threadId) ?? thread.name,
          preview: thread.preview,
        },
        buildThreadHistoryPreviewTurns(thread.turns, THREAD_HISTORY_PREVIEW_TURN_LIMIT),
      );
      await this.upsertThreadHistoryPreview(scopeId, thread.threadId, text);
    } catch (error) {
      this.logger.warn('telegram.thread_history_preview_failed', {
        scopeId,
        threadId,
        error: String(error),
      });
    }
  }

  private async upsertThreadHistoryPreview(scopeId: string, threadId: string, text: string): Promise<void> {
    const messageId = await this.sendHtmlMessage(scopeId, text);
    this.store.saveThreadHistoryPreview({ scopeId, threadId, messageId });
  }

  private async handleThreadRenameCallback(
    event: TelegramCallbackEvent,
    action: 'start' | 'confirm' | 'cancel',
    threadId: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if (action === 'start') {
      const started = await this.startThreadRenameDraft(scopeId, threadId, locale);
      await this.bot.answerCallback(
        event.callbackQueryId,
        started ? t(locale, 'thread_rename_started') : t(locale, 'thread_no_longer_available'),
      );
      return;
    }

    const draft = this.threadRenameDrafts.get(scopeId) ?? null;
    if (!draft || draft.threadId !== threadId) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'thread_rename_missing'));
      return;
    }

    if (action === 'cancel') {
      await this.resolveThreadRenameDraft(scopeId, draft, t(locale, 'thread_rename_cancelled'));
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'thread_rename_cancelled'));
      return;
    }

    if (!draft.proposedName) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'thread_rename_input_required'));
      return;
    }

    try {
      await this.app.renameThread(threadId, draft.proposedName);
    } catch (error) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'thread_rename_sync_failed', { error: formatUserError(error) }));
      return;
    }

    this.store.setThreadNameOverride(scopeId, threadId, draft.proposedName);
    await this.resolveThreadRenameDraft(scopeId, draft, t(locale, 'thread_rename_updated', { value: draft.proposedName }));
    await this.bot.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    try {
      await this.showThreadsPanel(scopeId, undefined, undefined, locale);
    } catch (error) {
      this.logger.warn('thread.rename_refresh_failed', { scopeId, threadId, error: String(error) });
    }
  }

  private async startThreadRenameDraft(scopeId: string, threadId: string, locale: AppLocale): Promise<boolean> {
    const existing = this.threadRenameDrafts.get(scopeId) ?? null;
    if (existing) {
      await this.resolveThreadRenameDraft(scopeId, existing, t(locale, 'thread_rename_cancelled'));
    }

    const cached = this.store.listCachedThreads(scopeId).find((thread) => thread.threadId === threadId) ?? null;
    if (!cached) {
      const thread = await this.app.readThread(threadId, false);
      if (!thread) {
        return false;
      }
      const currentName = normalizeThreadRenameLabel(thread.name || thread.preview || t(locale, 'untitled'));
      const promptMessageId = await this.sendMessage(
        scopeId,
        t(locale, 'thread_rename_prompt', { threadId, value: truncateInline(currentName, 60) }),
        threadRenamePromptKeyboard(locale, threadId, false),
      );
      this.threadRenameDrafts.set(scopeId, {
        threadId,
        currentName,
        proposedName: null,
        promptMessageId,
        createdAt: Date.now(),
      });
      return true;
    }

    const currentName = normalizeThreadRenameLabel(cached.name || cached.preview || t(locale, 'untitled'));
    const promptMessageId = await this.sendMessage(
      scopeId,
      t(locale, 'thread_rename_prompt', { threadId, value: truncateInline(currentName, 60) }),
      threadRenamePromptKeyboard(locale, threadId, false),
    );
    this.threadRenameDrafts.set(scopeId, {
      threadId,
      currentName,
      proposedName: null,
      promptMessageId,
      createdAt: Date.now(),
    });
    return true;
  }

  private async handleThreadRenameText(
    scopeId: string,
    draft: ThreadRenameDraft,
    text: string,
    locale: AppLocale,
  ): Promise<void> {
    const nextName = normalizeThreadRenameInput(text);
    if (!nextName) {
      await this.sendMessage(scopeId, t(locale, 'thread_rename_invalid'));
      return;
    }

    draft.proposedName = nextName;
    const reviewText = t(locale, 'thread_rename_review', {
      threadId: draft.threadId,
      from: truncateInline(draft.currentName, 60),
      to: truncateInline(nextName, 60),
    });
    const keyboard = threadRenamePromptKeyboard(locale, draft.threadId, true);
    try {
      await this.editMessage(scopeId, draft.promptMessageId, reviewText, keyboard);
      return;
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        this.logger.warn('thread.rename_prompt_edit_failed', {
          scopeId,
          threadId: draft.threadId,
          messageId: draft.promptMessageId,
          error: String(error),
        });
      }
    }

    draft.promptMessageId = await this.sendMessage(scopeId, reviewText, keyboard);
  }

  private async resolveThreadRenameDraft(scopeId: string, draft: ThreadRenameDraft, text: string): Promise<void> {
    this.threadRenameDrafts.delete(scopeId);
    try {
      await this.editMessage(scopeId, draft.promptMessageId, text, []);
      return;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        return;
      }
      this.logger.warn('thread.rename_prompt_resolve_failed', {
        scopeId,
        threadId: draft.threadId,
        messageId: draft.promptMessageId,
        error: String(error),
      });
    }
    await this.sendMessage(scopeId, text);
  }

  private async handleTurnInterruptCallback(event: TelegramCallbackEvent, turnId: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    const active = this.activeTurns.get(turnId);
    if (!active || active.scopeId !== scopeId) {
      await this.cleanupStaleInterruptButton(scopeId, event.messageId, locale);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'turn_already_finished'));
      return;
    }
    if (active.interruptRequested) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'interrupt_already_requested'));
      return;
    }
    active.interruptRequested = true;
    try {
      await this.requestInterrupt(active);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'interrupt_requested'));
    } catch (error) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'interrupt_failed', { error: formatUserError(error) }));
    }
  }

  private async handleNavigationCallback(
    event: TelegramCallbackEvent,
    target: 'models' | 'mode' | 'threads' | 'reveal' | 'permissions',
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if (target === 'models') {
      await this.showModelSettingsPanel(scopeId, event.messageId, locale);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'opened_model_settings'));
      return;
    }
    if (target === 'mode') {
      await this.showModeSettingsPanel(scopeId, event.messageId, locale);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'opened_mode_settings'));
      return;
    }
    if (target === 'permissions') {
      await this.showAccessSettingsPanel(scopeId, event.messageId, locale);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'opened_access_settings'));
      return;
    }
    if (target === 'threads') {
      await this.showThreadsPanel(scopeId, event.messageId, undefined, locale);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'opened_thread_list'));
      return;
    }

    const binding = this.store.getBinding(scopeId);
    if (!binding) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'no_thread_bound_callback'));
      return;
    }
    const readyBinding = await this.ensureThreadReady(scopeId, binding);
    const revealError = await this.tryRevealThread(scopeId, readyBinding.threadId, 'reveal');
    await this.bot.answerCallback(event.callbackQueryId, revealError ? t(locale, 'reveal_failed', { error: revealError }) : t(locale, 'opened_in_codex_short'));
  }

  private async showWherePanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    if (!binding) {
      const text = [
        t(locale, 'where_no_thread_bound'),
        t(locale, 'where_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
        t(locale, 'where_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
        t(locale, 'where_mode', { value: formatCollaborationModeLabel(locale, settings?.collaborationMode ?? null) }),
        t(locale, 'where_access_preset', { value: formatAccessPresetLabel(locale, access.preset) }),
        t(locale, 'where_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy) }),
        t(locale, 'where_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode) }),
        t(locale, 'where_send_message_or_new'),
      ].join('\n');
      if (messageId !== undefined) {
        await this.editMessage(scopeId, messageId, text, whereKeyboard(locale, false));
        return;
      }
      await this.sendMessage(scopeId, text, whereKeyboard(locale, false));
      return;
    }

    const readyBinding = await this.ensureThreadReady(scopeId, binding);
    const thread = await this.app.readThread(readyBinding.threadId, false);
    if (!thread) {
      const text = t(locale, 'where_thread_unavailable', { threadId: readyBinding.threadId });
      if (messageId !== undefined) {
        await this.editMessage(scopeId, messageId, text, whereKeyboard(locale, false));
        return;
      }
      await this.sendMessage(scopeId, text, whereKeyboard(locale, false));
      return;
    }

    const threadWithDisplayName = {
      ...thread,
      name: this.store.getThreadNameOverride(scopeId, thread.threadId) ?? thread.name,
    };
    const text = formatWhereMessage(locale, threadWithDisplayName, settings, this.config.defaultCwd, access);
    if (messageId !== undefined) {
      await this.editMessage(scopeId, messageId, text, whereKeyboard(locale, true));
      return;
    }
    await this.sendMessage(scopeId, text, whereKeyboard(locale, true));
  }

  private async showThreadsPanel(scopeId: string, messageId?: number, searchTerm?: string | null, locale = this.localeForChat(scopeId)): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const threads = await this.app.listThreads({
      limit: this.config.threadListLimit,
      searchTerm: searchTerm ?? null,
    });
    const cached = threads.map((thread) => ({
      threadId: thread.threadId,
      name: this.store.getThreadNameOverride(scopeId, thread.threadId) ?? thread.name,
      preview: thread.preview,
      cwd: thread.cwd,
      modelProvider: thread.modelProvider,
      status: thread.status,
      updatedAt: thread.updatedAt,
    }));
    this.store.cacheThreadList(scopeId, cached);
    const text = formatThreadsMessage(locale, cached, binding?.threadId ?? null, searchTerm ?? null);
    const keyboard = buildThreadsKeyboard(locale, cached);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
  }

  private async showModelSettingsPanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const models = await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    const text = formatModelSettingsMessage(locale, models, settings);
    const keyboard = buildModelSettingsKeyboard(locale, models, settings);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
  }

  private async showModeSettingsPanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const text = formatModeSettingsMessage(locale, settings);
    const keyboard = buildModeSettingsKeyboard(locale, settings);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
  }

  private async showAccessSettingsPanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const access = this.resolveEffectiveAccess(scopeId);
    const text = formatAccessSettingsMessage(locale, access);
    const keyboard = buildAccessSettingsKeyboard(locale, access);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
  }

  private async showSettingsHomePanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    const text = formatSettingsHomeMessage(locale, {
      threadId: binding?.threadId ?? null,
      cwd: binding?.cwd ?? this.config.defaultCwd,
      settings,
      access,
      queueDepth: this.store.countQueuedTurnInputs(scopeId),
      activeTurnId: this.findActiveTurn(scopeId)?.turnId ?? null,
    });
    const keyboard = buildSettingsHomeKeyboard(locale, settings);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
  }

  private async handleSettingsCallback(
    event: TelegramCallbackEvent,
    kind: 'model' | 'effort' | 'mode' | 'access',
    rawValue: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if ((kind === 'model' || kind === 'effort') && this.findActiveTurn(scopeId)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
      return;
    }

    if (kind === 'access') {
      await this.handleAccessSettingsCallback(event, rawValue, locale);
      return;
    }
    if (kind === 'mode') {
      await this.handleModeSettingsCallback(event, rawValue, locale);
      return;
    }

    const models = await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    const value = kind === 'model' ? decodeURIComponent(rawValue) : rawValue;

    if (kind === 'model') {
      if (value === 'default') {
        const defaultModel = resolveCurrentModel(models, null);
        const nextEffort = clampEffortToModel(defaultModel, settings?.reasoningEffort ?? null);
        this.store.setChatSettings(scopeId, null, nextEffort.effort);
        await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
        await this.bot.answerCallback(event.callbackQueryId, t(locale, 'using_server_default_model'));
        return;
      }
      const selected = resolveRequestedModel(models, value);
      if (!selected) {
        await this.bot.answerCallback(event.callbackQueryId, t(locale, 'model_no_longer_available'));
        return;
      }
      const nextEffort = clampEffortToModel(selected, settings?.reasoningEffort ?? null);
      this.store.setChatSettings(scopeId, selected.model, nextEffort.effort);
      await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'callback_model', { model: selected.model }));
      return;
    }

    if (value === 'default') {
      this.store.setChatSettings(scopeId, settings?.model ?? null, null);
      await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'using_default_effort'));
      return;
    }

    const effort = normalizeRequestedEffort(value);
    if (!effort) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unknown_effort'));
      return;
    }
    const currentModel = resolveCurrentModel(models, settings?.model ?? null);
    if (currentModel && currentModel.supportedReasoningEfforts.length > 0 && !currentModel.supportedReasoningEfforts.includes(effort)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'effort_not_supported_by_model'));
      return;
    }
    this.store.setChatSettings(scopeId, settings?.model ?? null, effort);
    await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
    await this.bot.answerCallback(event.callbackQueryId, t(locale, 'callback_effort', { effort }));
  }

  private async handleGuidedPlanSettingsCallback(
    event: TelegramCallbackEvent,
    kind: 'plan-gate' | 'queue' | 'history',
    rawValue: 'on' | 'off',
    locale: AppLocale,
  ): Promise<void> {
    const enabled = rawValue === 'on';
    this.store.setChatGuidedPlanPreferences(event.scopeId, kind === 'plan-gate'
      ? { confirmPlanBeforeExecute: enabled }
      : kind === 'queue'
        ? { autoQueueMessages: enabled }
        : { persistPlanHistory: enabled });
    await this.showSettingsHomePanel(event.scopeId, event.messageId, locale);
    await this.bot.answerCallback(
      event.callbackQueryId,
      t(
        locale,
        kind === 'plan-gate'
          ? 'settings_plan_gate_updated'
          : kind === 'queue'
            ? 'settings_auto_queue_updated'
            : 'settings_plan_history_updated',
        { value: t(locale, enabled ? 'yes' : 'no') },
      ),
    );
  }

  private async handleAccessSettingsCallback(event: TelegramCallbackEvent, rawValue: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    const nextPreset = normalizeAccessPreset(rawValue);
    if (!nextPreset) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    this.store.setChatAccessPreset(scopeId, nextPreset);
    await this.refreshAccessSettingsPanel(scopeId, event.messageId, locale);
    await this.bot.answerCallback(event.callbackQueryId, t(locale, 'callback_access', {
      value: formatAccessPresetLabel(locale, nextPreset),
    }));
  }

  private async handleModeSettingsCallback(event: TelegramCallbackEvent, rawValue: string, locale: AppLocale): Promise<void> {
    const nextMode = normalizeRequestedCollaborationMode(rawValue);
    if (!nextMode && rawValue !== 'default') {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    this.store.setChatCollaborationMode(event.scopeId, nextMode);
    if (nextMode !== 'plan') {
      await this.clearPendingUserInputsIfNeeded(event.scopeId, locale);
    }
    await this.refreshModeSettingsPanel(event.scopeId, event.messageId, locale);
    await this.bot.answerCallback(event.callbackQueryId, t(locale, 'callback_mode', {
      value: formatCollaborationModeLabel(locale, nextMode),
    }));
  }

  private async refreshModelSettingsPanel(scopeId: string, messageId: number, locale: AppLocale, models?: ModelInfo[]): Promise<void> {
    const resolvedModels = models ?? await this.app.listModels();
    const settings = this.store.getChatSettings(scopeId);
    await this.editHtmlMessage(
      scopeId,
      messageId,
      formatModelSettingsMessage(locale, resolvedModels, settings),
      buildModelSettingsKeyboard(locale, resolvedModels, settings),
    );
  }

  private async refreshModeSettingsPanel(scopeId: string, messageId: number, locale: AppLocale): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    await this.editHtmlMessage(
      scopeId,
      messageId,
      formatModeSettingsMessage(locale, settings),
      buildModeSettingsKeyboard(locale, settings),
    );
  }

  private async refreshAccessSettingsPanel(scopeId: string, messageId: number, locale: AppLocale): Promise<void> {
    const access = this.resolveEffectiveAccess(scopeId);
    await this.editHtmlMessage(
      scopeId,
      messageId,
      formatAccessSettingsMessage(locale, access),
      buildAccessSettingsKeyboard(locale, access),
    );
  }

  private async requestInterrupt(active: ActiveTurn): Promise<void> {
    active.interruptRequested = true;
    try {
      await this.app.interruptTurn(active.threadId, active.turnId);
      await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    } catch (error) {
      active.interruptRequested = false;
      throw error;
    }
  }

  private async queueTurnRender(
    active: ActiveTurn,
    options: { forceStatus?: boolean; forceStream?: boolean } = {},
  ): Promise<void> {
    this.clearRenderRetry(active);
    active.renderRequested = true;
    active.forceStatusFlush = active.forceStatusFlush || Boolean(options.forceStatus);
    active.forceStreamFlush = active.forceStreamFlush || Boolean(options.forceStream);
    if (active.renderTask) {
      await active.renderTask;
      return;
    }
    active.renderTask = (async () => {
      while (active.renderRequested) {
        const forceStatus = active.forceStatusFlush;
        const forceStream = active.forceStreamFlush;
        active.renderRequested = false;
        active.forceStatusFlush = false;
        active.forceStreamFlush = false;
        await this.syncTurnStream(active, forceStream);
        await this.syncTurnStatus(active, forceStatus);
      }
    })().finally(() => {
      active.renderTask = null;
    });
    await active.renderTask;
  }

  private async syncTurnStatus(active: ActiveTurn, force: boolean): Promise<void> {
    if (active.pendingArchivedStatus) {
      const archived = await this.archiveStatusMessage(active, active.pendingArchivedStatus);
      if (!archived) {
        return;
      }
      active.pendingArchivedStatus = null;
    }

    const text = this.renderActiveStatus(active);
    if (active.previewActive && active.statusNeedsRebase) {
      await this.rebaseStatusMessage(active, text);
      return;
    }
    if (!force && text === active.statusMessageText && active.previewActive) {
      return;
    }
    await this.ensureStatusMessage(active, text);
  }

  private async syncTurnStream(active: ActiveTurn, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - active.lastStreamFlushAt < this.config.telegramPreviewThrottleMs) {
      return;
    }

    active.lastStreamFlushAt = now;
    if (active.renderRoute.currentRenderer === 'draft_stream') {
      await this.syncDraftTurnStream(active, force);
      return;
    }

    for (const segment of active.segments) {
      await this.syncSegmentTimeline(active, segment);
    }
  }

  private async cleanupStaleTurnPreviews(): Promise<void> {
    for (const preview of this.store.listActiveTurnPreviews()) {
      await this.retirePreviewMessage(
        preview.scopeId,
        preview.messageId,
        t(this.localeForChat(preview.scopeId), 'stale_preview_restarted', { threadId: preview.threadId }),
        preview.turnId,
      );
    }
  }

  private async cleanupFinishedPreview(
    active: Pick<ActiveTurn, 'scopeId' | 'previewMessageId' | 'turnId' | 'interruptRequested' | 'previewActive'>,
    locale: AppLocale,
  ): Promise<void> {
    if (!active.previewActive) {
      return;
    }
    try {
      await this.deleteMessage(active.scopeId, active.previewMessageId);
      this.store.removeActiveTurnPreview(active.turnId);
      return;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        this.store.removeActiveTurnPreview(active.turnId);
        return;
      }
      this.logger.warn('telegram.preview_delete_failed', { error: String(error), turnId: active.turnId });
    }

    await this.retirePreviewMessage(
      active.scopeId,
      active.previewMessageId,
      t(locale, active.interruptRequested ? 'interrupted_see_reply_below' : 'completed_see_reply_below'),
      active.turnId,
    );
  }

  private async cleanupStaleInterruptButton(scopeId: string, messageId: number, locale: AppLocale): Promise<void> {
    try {
      await this.clearMessageButtons(scopeId, messageId);
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        this.logger.warn('telegram.stale_interrupt_cleanup_failed', {
          scopeId,
          messageId,
          locale,
          error: String(error),
        });
      }
    }
  }

  private async cleanupTransientPreview(scopeId: string, messageId: number): Promise<boolean> {
    try {
      await this.deleteMessage(scopeId, messageId);
      return true;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        return true;
      }
      this.logger.warn('telegram.preview_transient_cleanup_failed', { scopeId, messageId, error: String(error) });
      return false;
    }
  }

  private async abandonActiveTurns(): Promise<void> {
    const activeTurns = [...this.activeTurns.values()];
    for (const active of activeTurns) {
      this.clearToolBatchTimer(active.toolBatch);
      this.clearRenderRetry(active);
      if (active.previewActive) {
        await this.retirePreviewMessage(
          active.scopeId,
          active.previewMessageId,
          t(this.localeForChat(active.scopeId), 'stale_preview_expired'),
          active.turnId,
        );
      }
      active.resolver();
      this.activeTurns.delete(active.turnId);
    }
    if (activeTurns.length > 0) {
      this.updateStatus();
    }
  }

  private async retirePreviewMessage(scopeId: string, messageId: number, text: string, turnId?: string): Promise<void> {
    try {
      await this.editMessage(scopeId, messageId, text, []);
      this.forgetPreviewRecord(scopeId, messageId, turnId);
      return;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        this.forgetPreviewRecord(scopeId, messageId, turnId);
        return;
      }
      this.logger.warn('telegram.preview_text_cleanup_failed', {
        scopeId,
        messageId,
        turnId: turnId ?? null,
        error: String(error),
      });
    }

    try {
      await this.clearMessageButtons(scopeId, messageId);
      this.forgetPreviewRecord(scopeId, messageId, turnId);
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        this.forgetPreviewRecord(scopeId, messageId, turnId);
        return;
      }
      this.logger.warn('telegram.preview_markup_cleanup_failed', {
        scopeId,
        messageId,
        turnId: turnId ?? null,
        error: String(error),
      });
    }
  }

  private forgetPreviewRecord(scopeId: string, messageId: number, turnId?: string): void {
    if (turnId) {
      this.store.removeActiveTurnPreview(turnId);
      return;
    }
    this.store.removeActiveTurnPreviewByMessage(scopeId, messageId);
  }

  private async clearMessageButtons(scopeId: string, messageId: number): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.clearMessageInlineKeyboard(target.chatId, messageId);
  }

  private async sendDraft(scopeId: string, draftId: number, text: string): Promise<void> {
    const target = parseTelegramScopeId(scopeId);
    await this.bot.sendMessageDraft(target.chatId, draftId, text, target.topicId);
  }

  private renderActiveStatus(active: ActiveTurn): string {
    const locale = this.localeForChat(active.scopeId);
    const baseStatus = renderActiveTurnStatus(locale, {
      interruptRequested: active.interruptRequested,
      pendingApprovalKinds: active.pendingApprovalKinds,
      awaitingUserInput: active.pendingUserInputId !== null,
      toolStatusText: active.toolBatch
        ? formatToolBatchStatus(locale, active.toolBatch.counts, active.toolBatch.actionLines, true)
        : null,
      reasoningActive: active.reasoningActiveCount > 0,
      hasStreamingReply: this.findStreamingSegment(active) !== null,
    });
    const queuedTurns = this.store.countQueuedTurnInputs(active.scopeId);
    return queuedTurns > 0
      ? `${baseStatus}\n${t(locale, 'queue_status_inline', { value: queuedTurns })}`
      : baseStatus;
  }

  private async dismissTurnPreview(active: ActiveTurn): Promise<void> {
    if (!active.previewActive) {
      return;
    }
    const cleared = await this.cleanupTransientPreview(active.scopeId, active.previewMessageId);
    if (!cleared) {
      this.scheduleRenderRetry(active);
      return;
    }
    active.previewActive = false;
    active.statusMessageText = null;
    active.statusNeedsRebase = false;
    this.store.removeActiveTurnPreview(active.turnId);
  }

  private async ensureStatusMessage(active: ActiveTurn, text: string): Promise<void> {
    if (!active.previewActive) {
      try {
        const messageId = await this.sendMessage(
          active.scopeId,
          text,
          active.interruptRequested ? [] : activeTurnKeyboard(this.localeForChat(active.scopeId), active.turnId),
        );
        active.previewMessageId = messageId;
        active.previewActive = true;
        active.statusMessageText = text;
        active.statusNeedsRebase = false;
        this.store.saveActiveTurnPreview({
          turnId: active.turnId,
          scopeId: active.scopeId,
          threadId: active.threadId,
          messageId,
        });
      } catch (error) {
        this.logger.warn('telegram.preview_send_failed', { error: String(error), turnId: active.turnId });
        this.scheduleRenderRetry(active);
      }
      return;
    }
    try {
      await this.editMessage(
        active.scopeId,
        active.previewMessageId,
        text,
        active.interruptRequested ? [] : activeTurnKeyboard(this.localeForChat(active.scopeId), active.turnId),
      );
      active.statusMessageText = text;
      active.statusNeedsRebase = false;
      this.clearRenderRetry(active);
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        active.previewActive = false;
        active.statusMessageText = null;
        active.statusNeedsRebase = false;
        this.store.removeActiveTurnPreview(active.turnId);
        await this.ensureStatusMessage(active, text);
        return;
      }
      this.logger.warn('telegram.preview_edit_failed', {
        error: String(error),
        turnId: active.turnId,
        messageId: active.previewMessageId,
      });
      this.scheduleRenderRetry(active);
      return;
    }
  }

  private async rebaseStatusMessage(active: ActiveTurn, text: string): Promise<void> {
    if (active.previewActive) {
      const cleared = await this.cleanupTransientPreview(active.scopeId, active.previewMessageId);
      if (!cleared) {
        this.scheduleRenderRetry(active);
        return;
      }
      active.previewActive = false;
      active.statusMessageText = null;
      this.store.removeActiveTurnPreview(active.turnId);
    }
    active.statusNeedsRebase = false;
    await this.ensureStatusMessage(active, text);
  }

  private async archiveStatusMessage(active: ActiveTurn, content: ArchivedStatusContent): Promise<boolean> {
    if (!active.previewActive) {
      try {
        if (content.html) {
          await this.sendHtmlMessage(active.scopeId, content.html);
        } else {
          await this.sendMessage(active.scopeId, content.text);
        }
      } catch (error) {
        this.logger.warn('telegram.preview_archive_send_failed', { error: String(error), turnId: active.turnId });
        this.scheduleRenderRetry(active);
        return false;
      }
      return true;
    }
    try {
      if (content.html) {
        await this.editHtmlMessage(active.scopeId, active.previewMessageId, content.html, []);
      } else {
        await this.editMessage(active.scopeId, active.previewMessageId, content.text, []);
      }
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        active.previewActive = false;
        active.statusMessageText = null;
        active.statusNeedsRebase = false;
        this.store.removeActiveTurnPreview(active.turnId);
        return this.archiveStatusMessage(active, content);
      }
      this.logger.warn('telegram.preview_archive_failed', {
        error: String(error),
        turnId: active.turnId,
        messageId: active.previewMessageId,
      });
      this.scheduleRenderRetry(active);
      return false;
    }
    active.previewActive = false;
    active.statusMessageText = null;
    active.statusNeedsRebase = false;
    this.store.removeActiveTurnPreview(active.turnId);
    return true;
  }

  private noteToolCommandStart(active: ActiveTurn, event: RawExecCommandEvent): void {
    if (!active.toolBatch) {
      active.toolBatch = createToolBatchState();
    }
    this.clearToolBatchTimer(active.toolBatch);
    active.toolBatch.openCallIds.add(event.callId);
    const descriptors = describeExecCommand(event);
    for (const descriptor of descriptors) {
      if (active.toolBatch.actionKeys.has(descriptor.key)) {
        continue;
      }
      active.toolBatch.actionKeys.add(descriptor.key);
      active.toolBatch.actionLines.push(descriptor.line);
      incrementToolBatchCount(active.toolBatch.counts, descriptor.kind);
    }
  }

  private noteToolCommandEnd(active: ActiveTurn, event: RawExecCommandEvent): void {
    if (!active.toolBatch) {
      active.toolBatch = createToolBatchState();
    }
    const descriptors = describeExecCommand(event);
    for (const descriptor of descriptors) {
      if (active.toolBatch.actionKeys.has(descriptor.key)) {
        continue;
      }
      active.toolBatch.actionKeys.add(descriptor.key);
      active.toolBatch.actionLines.push(descriptor.line);
      incrementToolBatchCount(active.toolBatch.counts, descriptor.kind);
    }
    active.toolBatch.openCallIds.delete(event.callId);
    this.scheduleToolBatchArchive(active);
  }

  private scheduleToolBatchArchive(active: ActiveTurn): void {
    const batch = active.toolBatch;
    if (!batch || batch.openCallIds.size > 0) {
      return;
    }
    this.clearToolBatchTimer(batch);
    batch.finalizeTimer = setTimeout(() => {
      const current = this.activeTurns.get(active.turnId);
      if (!current || current.toolBatch !== batch || batch.openCallIds.size > 0) {
        return;
      }
      batch.finalizeTimer = null;
      current.pendingArchivedStatus = renderArchivedToolBatchStatus(this.localeForChat(current.scopeId), batch.counts, batch.actionLines);
      current.toolBatch = null;
      void this.queueTurnRender(current, { forceStatus: true });
    }, 600);
  }

  private promoteReadyToolBatch(active: ActiveTurn): void {
    const batch = active.toolBatch;
    if (!batch || batch.openCallIds.size > 0) {
      return;
    }
    this.clearToolBatchTimer(batch);
    active.pendingArchivedStatus = renderArchivedToolBatchStatus(this.localeForChat(active.scopeId), batch.counts, batch.actionLines);
    active.toolBatch = null;
  }

  private clearToolBatchTimer(batch: ToolBatchState | null): void {
    if (!batch?.finalizeTimer) {
      return;
    }
    clearTimeout(batch.finalizeTimer);
    batch.finalizeTimer = null;
  }

  private scheduleRenderRetry(active: ActiveTurn, delayMs = 1500): void {
    if (active.renderRetryTimer) {
      return;
    }
    active.renderRetryTimer = setTimeout(() => {
      active.renderRetryTimer = null;
      if (!this.activeTurns.has(active.turnId)) {
        return;
      }
      void this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    }, delayMs);
  }

  private clearRenderRetry(active: ActiveTurn): void {
    if (!active.renderRetryTimer) {
      return;
    }
    clearTimeout(active.renderRetryTimer);
    active.renderRetryTimer = null;
  }

  private async notePendingApprovalStatus(threadId: string, kind: PendingApprovalRecord['kind']): Promise<void> {
    const active = this.findActiveTurnByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingApprovalKinds.add(kind);
    await this.queueTurnRender(active, { forceStatus: true });
  }

  private async clearPendingApprovalStatus(threadId: string, kind: PendingApprovalRecord['kind']): Promise<void> {
    const active = this.findActiveTurnByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingApprovalKinds.delete(kind);
    await this.queueTurnRender(active, { forceStatus: true });
  }

  private async notePendingUserInputStatus(threadId: string, localId: string): Promise<void> {
    const active = this.findActiveTurnByThreadId(threadId);
    if (!active) {
      return;
    }
    active.pendingUserInputId = localId;
    await this.queueTurnRender(active, { forceStatus: true });
  }

  private async clearPendingUserInputStatus(threadId: string, localId: string): Promise<void> {
    const active = this.findActiveTurnByThreadId(threadId);
    if (!active || active.pendingUserInputId !== localId) {
      return;
    }
    active.pendingUserInputId = null;
    await this.queueTurnRender(active, { forceStatus: true });
  }

  private async openPendingUserInputPrompt(record: PendingUserInputRecord, locale: AppLocale): Promise<number> {
    const rendered = this.renderPendingUserInputStage(locale, record);
    const messageId = await this.sendHtmlMessage(record.chatId, rendered.html, rendered.keyboard);
    this.store.savePendingUserInputMessage({
      inputLocalId: record.localId,
      questionIndex: rendered.questionIndex,
      messageId,
      messageKind: rendered.messageKind,
      createdAt: Date.now(),
    });
    return messageId;
  }

  private async refreshPendingUserInputPrompt(record: PendingUserInputRecord, locale: AppLocale): Promise<void> {
    const rendered = this.renderPendingUserInputStage(locale, record);
    if (record.messageId !== null) {
      try {
        await this.editHtmlMessage(record.chatId, record.messageId, rendered.html, rendered.keyboard);
        this.store.savePendingUserInputMessage({
          inputLocalId: record.localId,
          questionIndex: rendered.questionIndex,
          messageId: record.messageId,
          messageKind: rendered.messageKind,
          createdAt: Date.now(),
        });
        return;
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          throw error;
        }
      }
    }
    const messageId = await this.sendHtmlMessage(record.chatId, rendered.html, rendered.keyboard);
    this.store.savePendingUserInputMessage({
      inputLocalId: record.localId,
      questionIndex: rendered.questionIndex,
      messageId,
      messageKind: rendered.messageKind,
      createdAt: Date.now(),
    });
    this.store.updatePendingUserInputMessage(record.localId, messageId);
  }

  private renderPendingUserInputStage(
    locale: AppLocale,
    record: PendingUserInputRecord,
  ): {
    html: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
    messageKind: 'question' | 'review';
    questionIndex: number;
  } {
    if (isPendingUserInputReview(record)) {
      return {
        ...renderPendingUserInputReviewMessage(locale, record),
        messageKind: 'review',
        questionIndex: Math.max(0, record.questions.length - 1),
      };
    }
    const currentQuestion = record.questions[record.currentQuestionIndex] ?? null;
    return {
      ...renderPendingUserInputMessage(locale, record, currentQuestion),
      messageKind: 'question',
      questionIndex: record.currentQuestionIndex,
    };
  }

  private async finalizePendingUserInput(
    record: PendingUserInputRecord,
    answers: Record<string, string[]>,
    locale: AppLocale,
  ): Promise<void> {
    await this.app.respond(record.serverRequestId, { answers: buildPendingUserInputResponse(answers) });
    this.store.markPendingUserInputResolved(record.localId);
    await this.clearPendingUserInputStatus(record.threadId, record.localId);
    if (record.messageId !== null) {
      try {
        await this.editHtmlMessage(record.chatId, record.messageId, renderResolvedPendingUserInputMessage(locale, record, answers), []);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.pending_input_resolved_edit_failed', {
            localId: record.localId,
            error: String(error),
          });
        }
      }
    }
    this.updateStatus();
  }

  private async cancelPendingUserInput(record: PendingUserInputRecord, locale: AppLocale): Promise<void> {
    await this.app.respondError(record.serverRequestId, 'User cancelled the requested input');
    this.store.markPendingUserInputResolved(record.localId);
    await this.clearPendingUserInputStatus(record.threadId, record.localId);
    if (record.messageId !== null) {
      try {
        await this.editHtmlMessage(record.chatId, record.messageId, renderCancelledPendingUserInputMessage(locale, record), []);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.pending_input_cancel_edit_failed', {
            localId: record.localId,
            error: String(error),
          });
        }
      }
    }
    this.updateStatus();
  }

  private async rewindPendingUserInput(
    record: PendingUserInputRecord,
    targetQuestionIndex: number,
    locale: AppLocale,
  ): Promise<void> {
    const nextIndex = Math.max(0, Math.min(targetQuestionIndex, Math.max(0, record.questions.length - 1)));
    const retainedAnswers = Object.fromEntries(
      record.questions
        .slice(0, nextIndex)
        .map((question) => [question.id, record.answers[question.id]])
        .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0),
    );
    this.store.updatePendingUserInputState(record.localId, retainedAnswers, nextIndex, false);
    const updated = this.store.getPendingUserInput(record.localId);
    if (!updated) {
      return;
    }
    await this.refreshPendingUserInputPrompt(updated, locale);
    this.updateStatus();
  }

  private async applyPendingUserInputAnswer(
    record: PendingUserInputRecord,
    answer: string[],
    locale: AppLocale,
  ): Promise<void> {
    const currentQuestion = record.questions[record.currentQuestionIndex] ?? null;
    if (!currentQuestion) {
      return;
    }
    await this.lockPendingUserInputPrompt(record, currentQuestion, answer, locale);
    const answers = {
      ...record.answers,
      [currentQuestion.id]: answer,
    };
    const nextQuestionIndex = record.currentQuestionIndex + 1;
    this.store.updatePendingUserInputState(record.localId, answers, nextQuestionIndex, false);
    const updated = this.store.getPendingUserInput(record.localId);
    if (!updated) {
      return;
    }
    if (nextQuestionIndex < updated.questions.length) {
      const messageId = await this.openPendingUserInputPrompt(updated, locale);
      this.store.updatePendingUserInputMessage(updated.localId, messageId);
      this.updateStatus();
      return;
    }
    await this.refreshPendingUserInputPrompt(updated, locale);
  }

  private async handlePendingUserInputText(
    scopeId: string,
    record: PendingUserInputRecord,
    text: string,
    locale: AppLocale,
  ): Promise<void> {
    if (isPendingUserInputReview(record)) {
      await this.sendMessage(scopeId, t(locale, 'input_review_buttons_only'));
      return;
    }
    const currentQuestion = record.questions[record.currentQuestionIndex] ?? null;
    if (currentQuestion?.options?.length && !record.awaitingFreeText) {
      await this.sendMessage(
        scopeId,
        currentQuestion.isOther ? t(locale, 'input_use_buttons_or_other') : t(locale, 'input_use_buttons_only'),
      );
      return;
    }
    const answer = text.trim();
    if (!answer) {
      await this.sendMessage(scopeId, t(locale, 'input_reply_only'));
      return;
    }
    await this.applyPendingUserInputAnswer(record, [answer], locale);
  }

  private async handlePendingUserInputCallback(
    event: TelegramCallbackEvent,
    localId: string,
    action: string,
    locale: AppLocale,
  ): Promise<void> {
    const record = this.store.getPendingUserInput(localId);
    if (!record || record.resolvedAt !== null) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'input_already_resolved'));
      return;
    }
    if (record.chatId !== event.scopeId || (record.messageId !== null && record.messageId !== event.messageId)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'input_mismatch'));
      return;
    }
    const question = record.questions[record.currentQuestionIndex] ?? null;
    if (!question && !isPendingUserInputReview(record)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'input_already_resolved'));
      return;
    }
    if (action === 'cancel') {
      await this.cancelPendingUserInput(record, locale);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'input_cancelled'));
      return;
    }
    if (isPendingUserInputReview(record)) {
      if (action === 'submit') {
        await this.finalizePendingUserInput(record, record.answers, locale);
        await this.bot.answerCallback(event.callbackQueryId, t(locale, 'input_submit_recorded'));
        return;
      }
      const editMatch = /^edit:(\d+)$/.exec(action);
      if (editMatch) {
        const targetIndex = Number.parseInt(editMatch[1] || '', 10);
        if (Number.isNaN(targetIndex)) {
          await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
          return;
        }
        await this.rewindPendingUserInput(record, targetIndex, locale);
        await this.bot.answerCallback(event.callbackQueryId, t(locale, 'input_edit_answer_requested'));
        return;
      }
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    if (!question) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'input_already_resolved'));
      return;
    }
    if (action === 'back') {
      if (record.currentQuestionIndex === 0) {
        await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
        return;
      }
      await this.rewindPendingUserInput(record, record.currentQuestionIndex - 1, locale);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'input_back_requested'));
      return;
    }
    if (action === 'other') {
      this.store.updatePendingUserInputState(record.localId, record.answers, record.currentQuestionIndex, true);
      const updated = this.store.getPendingUserInput(record.localId);
      if (updated) {
        await this.refreshPendingUserInputPrompt(updated, locale);
      }
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'input_custom_answer_requested'));
      return;
    }
    const match = /^option:(\d+)$/.exec(action);
    if (!match || !question.options) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    const optionIndex = Number.parseInt(match[1] || '', 10);
    const option = question.options[optionIndex];
    if (!option) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    await this.applyPendingUserInputAnswer(record, [option.label], locale);
    await this.bot.answerCallback(event.callbackQueryId, t(locale, 'input_answer_recorded'));
  }

  private async lockPendingUserInputPrompt(
    record: PendingUserInputRecord,
    question: PendingUserInputQuestion,
    answer: string[],
    locale: AppLocale,
  ): Promise<void> {
    if (record.messageId === null) {
      return;
    }
    try {
      await this.editHtmlMessage(
        record.chatId,
        record.messageId,
        renderAnsweredPendingUserInputMessage(locale, record, question, answer),
        [],
      );
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        throw error;
      }
    }
  }

  private async syncTurnPlan(active: ActiveTurn, params: any): Promise<void> {
    const explanation = typeof params?.explanation === 'string' && params.explanation.trim()
      ? params.explanation.trim()
      : null;
    const steps = normalizePlanSteps(Array.isArray(params?.plan) ? params.plan : []);
    const previousExplanation = active.planExplanation;
    const previousSteps = active.planSteps;
    active.planExplanation = explanation;
    active.planSteps = steps;
    active.planDraftText = null;
    const session = active.guidedPlanSessionId ? this.store.getPlanSession(active.guidedPlanSessionId) : null;
    let version = session?.latestPlanVersion ?? null;
    const latestSnapshot = !session || session.latestPlanVersion === null
      ? null
      : this.store.listPlanSnapshots(session.sessionId).at(-1) ?? null;
    const planChanged = latestSnapshot
      ? latestSnapshot.explanation !== explanation || !planStepsEqual(latestSnapshot.steps, steps)
      : previousExplanation !== explanation || !planStepsEqual(previousSteps, steps);
    if (session && planChanged) {
      version = (session.latestPlanVersion ?? 0) + 1;
      if (this.store.getChatSettings(active.scopeId)?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory) {
        this.store.savePlanSnapshot({
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
      this.updatePlanSession(session.sessionId, {
        latestPlanVersion: version ?? session.latestPlanVersion,
      });
    }
    await this.queuePlanRender(active);
  }

  private async syncDraftTurnStream(active: ActiveTurn, force: boolean): Promise<void> {
    for (const segment of active.segments) {
      if (!segment.completed) {
        continue;
      }
      await this.syncSegmentTimeline(active, segment);
    }

    const draftText = this.renderDraftStreamText(active);
    if (draftText === null) {
      active.draftText = null;
      return;
    }
    if (!force && draftText === active.draftText) {
      return;
    }
    if (!active.draftId) {
      active.draftId = crypto.randomInt(1, 2_147_483_647);
    }
    try {
      await this.sendDraft(active.scopeId, active.draftId, draftText);
      active.draftText = draftText;
    } catch (error) {
      this.logger.warn('telegram.draft_send_failed', {
        error: String(error),
        turnId: active.turnId,
        draftId: active.draftId,
      });
      this.scheduleRenderRetry(active);
    }
  }

  private renderDraftStreamText(active: ActiveTurn): string | null {
    const locale = this.localeForChat(active.scopeId);
    const streamingSegment = this.findStreamingSegment(active);
    if (streamingSegment) {
      return clipTelegramDraftMessage(streamingSegment.text, t(locale, 'working'));
    }
    return null;
  }

  private findStreamingSegment(active: ActiveTurn): ActiveTurnSegment | null {
    return [...active.segments].reverse().find(segment => !segment.completed && segment.text.trim()) ?? null;
  }

  private findActiveTurnByThreadId(threadId: string): ActiveTurn | null {
    for (const active of this.activeTurns.values()) {
      if (active.threadId === threadId) {
        return active;
      }
    }
    return null;
  }

  private async syncSegmentTimeline(active: ActiveTurn, segment: ActiveTurnSegment): Promise<void> {
    const chunks = chunkTelegramStreamMessage(segment.text);
    let index = 0;
    while (index < chunks.length) {
      const chunk = chunks[index]!;
      const existing = segment.messages[index];
      if (!existing) {
        try {
          const messageId = await this.sendMessage(active.scopeId, chunk);
          segment.messages.push({ messageId, text: chunk });
          active.statusNeedsRebase = true;
        } catch (error) {
          this.logger.warn('telegram.stream_send_failed', {
            error: String(error),
            turnId: active.turnId,
            itemId: segment.itemId,
            chunkIndex: index,
          });
          this.scheduleRenderRetry(active);
          return;
        }
        index += 1;
        continue;
      }
      if (existing.text === chunk) {
        index += 1;
        continue;
      }
      try {
        await this.editMessage(active.scopeId, existing.messageId, chunk);
        existing.text = chunk;
        index += 1;
      } catch (error) {
        if (isTelegramMessageGone(error)) {
          segment.messages.splice(index);
          continue;
        }
        this.logger.warn('telegram.stream_edit_failed', {
          error: String(error),
          turnId: active.turnId,
          itemId: segment.itemId,
          messageId: existing.messageId,
          chunkIndex: index,
        });
        this.scheduleRenderRetry(active);
        return;
      }
    }

    while (segment.messages.length > chunks.length) {
      const stale = segment.messages.pop();
      if (!stale) {
        break;
      }
      try {
        await this.deleteMessage(active.scopeId, stale.messageId);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.stream_delete_failed', {
            error: String(error),
            turnId: active.turnId,
            itemId: segment.itemId,
            messageId: stale.messageId,
          });
        }
      }
    }
  }
}

function ensureTurnSegment(
  active: ActiveTurn,
  itemId: string,
  phase?: string | null,
  outputKind?: TurnOutputKind,
): ActiveTurnSegment {
  let segment = active.segments.find((entry) => entry.itemId === itemId);
  if (segment) {
    if (phase !== undefined) {
      segment.phase = phase;
    }
    if (outputKind !== undefined) {
      segment.outputKind = outputKind;
    }
    return segment;
  }
  segment = {
    itemId,
    phase: phase ?? null,
    outputKind: outputKind ?? 'commentary',
    text: '',
    completed: false,
    messages: [],
  };
  active.segments.push(segment);
  return segment;
}

function createToolBatchState(): ToolBatchState {
  return {
    openCallIds: new Set<string>(),
    actionKeys: new Set<string>(),
    actionLines: [],
    counts: { files: 0, searches: 0, edits: 0, commands: 0 },
    finalizeTimer: null,
  };
}

function incrementToolBatchCount(counts: ToolBatchCounts, kind: keyof ToolBatchCounts): void {
  counts[kind] += 1;
}

function formatToolBatchStatus(
  locale: AppLocale,
  counts: ToolBatchCounts,
  actionLines: string[],
  inProgress: boolean,
): string {
  const heading = formatToolBatchHeading(locale, counts, inProgress);
  const detailLines = actionLines.slice(0, 6);
  if (detailLines.length === 0) {
    return heading;
  }
  return [heading, ...detailLines].join('\n');
}

function renderArchivedToolBatchStatus(
  locale: AppLocale,
  counts: ToolBatchCounts,
  actionLines: string[],
): ArchivedStatusContent {
  const text = formatToolBatchStatus(locale, counts, actionLines, false);
  if (actionLines.length === 0) {
    return { text, html: null };
  }
  const heading = formatToolBatchHeading(locale, counts, false);
  const detailLines = actionLines.slice(0, 12).map(line => escapeTelegramHtml(line));
  const html = [
    `<b>${escapeTelegramHtml(heading)}</b>`,
    `<blockquote expandable>${detailLines.join('\n')}</blockquote>`,
  ].join('\n');
  return { text, html };
}

function formatToolBatchHeading(locale: AppLocale, counts: ToolBatchCounts, inProgress: boolean): string {
  const parts = formatToolBatchCountParts(locale, counts);
  const hasBrowse = counts.files > 0 || counts.searches > 0;
  const hasEdit = counts.edits > 0;
  const hasCommand = counts.commands > 0;
  let verb: string;
  if (hasEdit && !hasBrowse && !hasCommand) {
    verb = locale === 'zh' ? (inProgress ? '正在编辑' : '已编辑') : (inProgress ? 'Editing' : 'Edited');
  } else if (hasBrowse && !hasEdit && !hasCommand) {
    verb = locale === 'zh' ? (inProgress ? '正在浏览' : '已浏览') : (inProgress ? 'Browsing' : 'Browsed');
  } else if (hasCommand && !hasBrowse && !hasEdit) {
    verb = locale === 'zh' ? (inProgress ? '正在运行' : '已运行') : (inProgress ? 'Running' : 'Ran');
  } else {
    verb = locale === 'zh' ? (inProgress ? '正在处理' : '已处理') : (inProgress ? 'Processing' : 'Processed');
  }
  if (parts.length === 0) {
    return locale === 'zh'
      ? `${verb}操作...`
      : `${verb} operations...`;
  }
  return locale === 'zh'
    ? `${verb} ${parts.join('，')}`
    : `${verb} ${parts.join(', ')}`;
}

function formatToolBatchCountParts(locale: AppLocale, counts: ToolBatchCounts): string[] {
  const parts: string[] = [];
  if (counts.files > 0) {
    parts.push(locale === 'zh' ? `${counts.files} 个文件` : pluralize(counts.files, 'file'));
  }
  if (counts.searches > 0) {
    parts.push(locale === 'zh' ? `${counts.searches} 个搜索` : pluralize(counts.searches, 'search'));
  }
  if (counts.edits > 0) {
    parts.push(locale === 'zh' ? `${counts.edits} 个编辑` : pluralize(counts.edits, 'edit'));
  }
  if (counts.commands > 0) {
    parts.push(locale === 'zh' ? `${counts.commands} 个命令` : pluralize(counts.commands, 'command'));
  }
  return parts;
}

function pluralize(count: number, noun: string): string {
  if (count === 1) {
    return `1 ${noun}`;
  }
  const plural = noun === 'search'
    ? 'searches'
    : noun === 'file'
      ? 'files'
      : `${noun}s`;
  return `${count} ${plural}`;
}

function describeExecCommand(event: RawExecCommandEvent): ToolDescriptor[] {
  const descriptors = (event.parsedCmd ?? [])
    .map((entry) => describeParsedCommand(entry))
    .filter((entry): entry is ToolDescriptor => entry !== null);
  if (descriptors.length > 0) {
    return descriptors;
  }
  const commandText = renderShellCommand(event.command);
  return [{
    kind: 'commands',
    key: `command:${commandText}`,
    line: `$ ${commandText}`,
  }];
}

function describeParsedCommand(entry: any): ToolDescriptor | null {
  const type = typeof entry?.type === 'string' ? entry.type : '';
  const path = compactPath(entry?.path ?? entry?.name ?? null);
  const query = typeof entry?.query === 'string' ? entry.query : null;
  switch (type) {
    case 'search':
      return {
        kind: 'searches',
        key: `search:${path ?? '.'}:${query ?? ''}`,
        line: path ? `Searched for ${truncateInline(query || '', 80)} in ${path}` : `Searched for ${truncateInline(query || '', 80)}`,
      };
    case 'read':
      return {
        kind: 'files',
        key: `read:${path ?? 'unknown'}`,
        line: `Read ${path ?? 'file'}`,
      };
    case 'list_files':
      return {
        kind: 'files',
        key: `list:${path ?? 'workspace'}`,
        line: path ? `Listed ${path}` : 'Listed files',
      };
    case 'write':
    case 'edit':
    case 'apply_patch':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Edited ${path ?? 'files'}`,
      };
    case 'move':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Moved ${path ?? 'files'}`,
      };
    case 'copy':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Copied ${path ?? 'files'}`,
      };
    case 'delete':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Deleted ${path ?? 'files'}`,
      };
    case 'mkdir':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Created ${path ?? 'files'}`,
      };
    default:
      return null;
  }
}

function compactPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  return value.replace(/^\.\//, '');
}

function renderShellCommand(command: string[]): string {
  if (command.length >= 3 && (command[0] === '/bin/zsh' || command[0] === 'zsh') && command[1] === '-lc') {
    return command[2] ?? command.join(' ');
  }
  return command.join(' ');
}

function truncateInline(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeThreadRenameLabel(value: string): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted || 'Untitled';
}

function normalizeThreadRenameInput(value: string): string | null {
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted || compacted.length > 60) {
    return null;
  }
  return compacted;
}

function normalizeRequestedCollaborationMode(value: string): CollaborationModeValue | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'default') {
    return null;
  }
  if (normalized === 'plan') {
    return 'plan';
  }
  return null;
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function approvalKeyboard(
  locale: AppLocale,
  localId: string,
  detailsOpen = false,
): Array<Array<{ text: string; callback_data: string }>> {
  return [
    [
      { text: t(locale, 'button_allow'), callback_data: `approval:${localId}:accept` },
      { text: t(locale, 'button_allow_session'), callback_data: `approval:${localId}:session` },
      { text: t(locale, 'button_deny'), callback_data: `approval:${localId}:deny` },
    ],
    [{
      text: t(locale, detailsOpen ? 'button_back' : 'button_details'),
      callback_data: `approval:${localId}:${detailsOpen ? 'back' : 'details'}`,
    }],
  ];
}

function planRecoveryKeyboard(
  locale: AppLocale,
  sessionId: string,
): Array<Array<{ text: string; callback_data: string }>> {
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
): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (canConfirm) {
    rows.push([{
      text: truncateInline(`${t(locale, 'button_recommended')}: ${t(locale, 'button_continue')}`, 32),
      callback_data: `plan:${sessionId}:confirm`,
    }]);
  }
  rows.push([
    { text: t(locale, 'button_revise'), callback_data: `plan:${sessionId}:revise` },
    { text: t(locale, 'button_cancel'), callback_data: `plan:${sessionId}:cancel` },
  ]);
  return rows;
}

function buildPendingInputNavigationRow(
  locale: AppLocale,
  localId: string,
  currentQuestionIndex: number,
): Array<{ text: string; callback_data: string }> {
  const row = [{ text: t(locale, 'button_cancel'), callback_data: `input:${localId}:cancel` }];
  if (currentQuestionIndex > 0) {
    row.unshift({ text: t(locale, 'button_back'), callback_data: `input:${localId}:back` });
  }
  return row;
}

function buildPendingUserInputReviewKeyboard(
  locale: AppLocale,
  record: PendingUserInputRecord,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [[
    { text: t(locale, 'button_submit'), callback_data: `input:${record.localId}:submit` },
    { text: t(locale, 'button_cancel'), callback_data: `input:${record.localId}:cancel` },
  ]];
  for (let index = 0; index < record.questions.length; index += 1) {
    const question = record.questions[index]!;
    rows.push([{
      text: truncateInline(`${t(locale, 'input_review_edit')}: ${question.header}`, 32),
      callback_data: `input:${record.localId}:edit:${index}`,
    }]);
  }
  return rows;
}

function activeTurnKeyboard(locale: AppLocale, turnId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_interrupt'), callback_data: `turn:interrupt:${turnId}` },
  ]];
}

function threadRenamePromptKeyboard(
  locale: AppLocale,
  threadId: string,
  hasProposedName: boolean,
): Array<Array<{ text: string; callback_data: string }>> {
  if (!hasProposedName) {
    return [[{ text: t(locale, 'button_cancel'), callback_data: `thread:rename:cancel:${threadId}` }]];
  }
  return [[
    { text: t(locale, 'button_confirm'), callback_data: `thread:rename:confirm:${threadId}` },
    { text: t(locale, 'button_cancel'), callback_data: `thread:rename:cancel:${threadId}` },
  ]];
}

function whereKeyboard(locale: AppLocale, hasBinding: boolean): Array<Array<{ text: string; callback_data: string }>> {
  const firstRow = [
    { text: t(locale, 'button_mode'), callback_data: 'nav:mode' },
    { text: t(locale, 'button_permissions'), callback_data: 'nav:permissions' },
  ];
  const secondRow = [
    { text: t(locale, 'button_models'), callback_data: 'nav:models' },
    { text: t(locale, 'button_threads'), callback_data: 'nav:threads' },
  ];
  if (!hasBinding) {
    return [firstRow, secondRow];
  }
  return [
    [{ text: t(locale, 'button_reveal'), callback_data: 'nav:reveal' }, { text: t(locale, 'button_mode'), callback_data: 'nav:mode' }],
    [{ text: t(locale, 'button_permissions'), callback_data: 'nav:permissions' }, { text: t(locale, 'button_models'), callback_data: 'nav:models' }],
    [{ text: t(locale, 'button_threads'), callback_data: 'nav:threads' }],
  ];
}

export function renderPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
  question: PendingUserInputQuestion | null,
): { html: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const progress = `${record.currentQuestionIndex + 1}/${Math.max(record.questions.length, 1)}`;
  const lines = [
    t(locale, 'input_requested'),
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
    `<b>${escapeTelegramHtml(question?.header || 'Question')} (${progress})</b>`,
    escapeTelegramHtml(question?.question || ''),
  ];
  const optionLines = (question?.options ?? [])
    .filter(option => option.label.trim())
    .map((option, index) => {
      const recommendedPrefix = index === 0 ? `${escapeTelegramHtml(t(locale, 'input_recommended'))}: ` : '';
      return `${index + 1}. ${recommendedPrefix}${escapeTelegramHtml(option.label)}${option.description ? ` - ${escapeTelegramHtml(option.description)}` : ''}`;
    });
  if (optionLines.length > 0) {
    lines.push(`<blockquote expandable>${optionLines.join('\n')}</blockquote>`);
  }
  if (record.awaitingFreeText) {
    lines.push(t(locale, 'input_reply_only'));
  } else if (optionLines.length > 0) {
    lines.push(question?.isOther ? t(locale, 'input_select_or_other') : t(locale, 'input_select_only'));
  } else {
    lines.push(t(locale, 'input_reply_only'));
  }
  lines.push(record.currentQuestionIndex > 0 ? t(locale, 'input_question_actions_back_cancel') : t(locale, 'input_question_actions_cancel'));
  return {
    html: lines.filter(Boolean).join('\n'),
    keyboard: buildPendingUserInputKeyboard(locale, record, question, record.awaitingFreeText),
  };
}

function buildPendingUserInputKeyboard(
  locale: AppLocale,
  record: PendingUserInputRecord,
  question: PendingUserInputQuestion | null,
  awaitingFreeText: boolean,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (question && !awaitingFreeText && question.options && question.options.length > 0) {
    rows.push(...question.options.map((option, index) => [{
      text: truncateInline(
        index === 0
          ? `${t(locale, 'button_recommended')}: ${option.label}`
          : option.label,
        32,
      ),
      callback_data: `input:${record.localId}:option:${index}`,
    }]));
  }
  if (question?.isOther) {
    rows.push([{ text: t(locale, 'button_other'), callback_data: `input:${record.localId}:other` }]);
  }
  rows.push(buildPendingInputNavigationRow(locale, record.localId, record.currentQuestionIndex));
  return rows;
}

export function renderPendingUserInputReviewMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
): { html: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const lines = [
    `<b>${escapeTelegramHtml(t(locale, 'input_review_title'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
    t(locale, 'input_review_prompt'),
  ];
  for (let index = 0; index < record.questions.length; index += 1) {
    const question = record.questions[index]!;
    const answer = record.answers[question.id] ?? [];
    lines.push(`<b>${index + 1}. ${escapeTelegramHtml(question.header)}</b>`);
    lines.push(t(locale, 'line_answer', { value: escapeTelegramHtml(answer.join(', ') || t(locale, 'empty')) }));
  }
  return {
    html: lines.join('\n'),
    keyboard: buildPendingUserInputReviewKeyboard(locale, record),
  };
}

export function renderAnsweredPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
  question: PendingUserInputQuestion,
  answer: string[],
): string {
  const progress = `${record.currentQuestionIndex + 1}/${Math.max(record.questions.length, 1)}`;
  return [
    `<b>${escapeTelegramHtml(t(locale, 'input_answer_recorded'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
    `<b>${escapeTelegramHtml(question.header)} (${progress})</b>`,
    escapeTelegramHtml(question.question),
    t(locale, 'line_answer', { value: escapeTelegramHtml(answer.join(', ')) }),
  ].filter(Boolean).join('\n');
}

export function renderResolvedPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
  answers: Record<string, string[]>,
): string {
  const lines = [
    `<b>${escapeTelegramHtml(t(locale, 'input_answer_recorded'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
  ];
  for (const question of record.questions) {
    const answer = answers[question.id];
    if (!answer || answer.length === 0) {
      continue;
    }
    lines.push(`<b>${escapeTelegramHtml(question.header)}</b>`);
    lines.push(t(locale, 'line_answer', { value: escapeTelegramHtml(answer.join(', ')) }));
  }
  return lines.join('\n');
}

export function renderCancelledPendingUserInputMessage(
  locale: AppLocale,
  record: PendingUserInputRecord,
): string {
  return [
    `<b>${escapeTelegramHtml(t(locale, 'input_cancelled'))}</b>`,
    t(locale, 'line_thread', { value: escapeTelegramHtml(record.threadId) }),
    t(locale, 'line_turn', { value: escapeTelegramHtml(record.turnId) }),
  ].join('\n');
}

export function buildPendingUserInputResponse(answers: Record<string, string[]>): Record<string, { answers: string[] }> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [questionId, { answers: value }]),
  );
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
): { html: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const hasReviewablePlan = session.latestPlanVersion !== null;
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
  lines.push(t(locale, hasReviewablePlan ? 'plan_review_prompt' : 'plan_review_prompt_no_snapshot'));
  lines.push(t(locale, hasReviewablePlan ? 'plan_review_actions' : 'plan_review_actions_revise_only'));
  return {
    html: lines.filter(Boolean).join('\n'),
    keyboard: planConfirmationKeyboard(locale, session.sessionId, hasReviewablePlan),
  };
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
): { html: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } {
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

function renderQueuedTurnReceiptMessage(locale: AppLocale, aheadCount: number): string {
  return aheadCount > 0
    ? t(locale, 'queue_receipt_with_ahead', { value: aheadCount })
    : t(locale, 'queue_receipt_next');
}

function renderQueueStatusMessage(
  locale: AppLocale,
  state: {
    activeTurnId: string | null;
    queueDepth: number;
    items: QueuedTurnInputRecord[];
  },
): string {
  const lines = [
    t(locale, 'queue_panel_title'),
    t(locale, 'queue_panel_active_turn', { value: state.activeTurnId ?? t(locale, 'none') }),
    t(locale, 'queue_panel_depth', { value: state.queueDepth }),
  ];
  if (state.items.length === 0) {
    lines.push(t(locale, 'queue_panel_empty'));
    return lines.join('\n');
  }
  lines.push(t(locale, 'queue_panel_list_title'));
  state.items.slice(0, 5).forEach((item, index) => {
    lines.push(`${index + 1}. ${item.sourceSummary || t(locale, 'queue_item_summary_fallback')}`);
  });
  if (state.items.length > 5) {
    lines.push(t(locale, 'queue_panel_more_items', { value: state.items.length - 5 }));
  }
  return lines.join('\n');
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

export function renderApprovalMessage(locale: AppLocale, record: PendingApprovalRecord, decision?: ApprovalAction): string {
  const lines = [
    t(locale, 'approval_requested', {
      kind: record.kind === 'fileChange' ? t(locale, 'approval_kind_fileChange') : t(locale, 'approval_kind_command'),
    }),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
  ];
  if (record.riskLevel) lines.push(t(locale, 'line_risk', { value: t(locale, `approval_risk_${record.riskLevel}`) }));
  if (record.summary) lines.push(t(locale, 'line_summary', { value: record.summary }));
  if (record.command) lines.push(t(locale, 'line_command', { value: truncateInline(record.command, 120) }));
  if (record.cwd) lines.push(t(locale, 'line_cwd', { value: record.cwd }));
  if (record.reason) lines.push(t(locale, 'line_reason', { value: record.reason }));
  if (decision) {
    const decisionKey = decision === 'accept'
      ? 'approval_decision_accept'
      : decision === 'session'
        ? 'approval_decision_session'
        : 'approval_decision_deny';
    lines.push(t(locale, 'line_decision', { value: t(locale, decisionKey) }));
  }
  return lines.join('\n');
}

export function renderApprovalDetailsMessage(locale: AppLocale, record: PendingApprovalRecord): string {
  const lines = [
    t(locale, 'approval_details_title'),
    t(locale, 'approval_requested', {
      kind: record.kind === 'fileChange' ? t(locale, 'approval_kind_fileChange') : t(locale, 'approval_kind_command'),
    }),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
  ];
  if (record.riskLevel) lines.push(t(locale, 'line_risk', { value: t(locale, `approval_risk_${record.riskLevel}`) }));
  if (record.summary) lines.push(t(locale, 'line_summary', { value: record.summary }));
  if (record.command) lines.push(t(locale, 'line_command', { value: record.command }));
  if (record.cwd) lines.push(t(locale, 'line_cwd', { value: record.cwd }));
  if (record.reason) lines.push(t(locale, 'line_reason', { value: record.reason }));
  const paths = Array.isArray(record.details?.paths)
    ? record.details.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  if (paths.length > 0) {
    lines.push(t(locale, 'line_paths', { value: truncateInline(paths.join(', '), 160) }));
  }
  const counts = formatApprovalChangeCounts(locale, record.details?.counts);
  if (counts) {
    lines.push(t(locale, 'approval_detail_counts', { value: counts }));
  }
  return lines.join('\n');
}

function queueControlKeyboard(locale: AppLocale): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_queue_cancel_next'), callback_data: 'queue:next' },
    { text: t(locale, 'button_queue_clear'), callback_data: 'queue:clear' },
  ]];
}

function deriveApprovalDetails(
  kind: PendingApprovalRecord['kind'],
  params: any,
): Pick<PendingApprovalRecord, 'summary' | 'riskLevel' | 'details'> {
  if (kind === 'command') {
    const commandText = typeof params?.command === 'string'
      ? params.command
      : Array.isArray(params?.command)
        ? params.command.map((part: unknown) => String(part)).join(' ')
        : null;
    return {
      summary: commandText ? truncateInline(commandText, 120) : 'Run a command in the workspace',
      riskLevel: inferCommandApprovalRisk(commandText),
      details: {
        command: commandText,
        cwd: typeof params?.cwd === 'string' ? params.cwd : null,
        parsedCmd: Array.isArray(params?.parsedCmd) ? params.parsedCmd : [],
      },
    };
  }

  const changes = normalizeFileChangeApprovalDetails(params);
  return {
    summary: changes.summary,
    riskLevel: inferFileChangeApprovalRisk(changes.paths, changes.counts),
    details: {
      paths: changes.paths,
      counts: changes.counts,
    },
  };
}

function normalizeFileChangeApprovalDetails(params: any): {
  paths: string[];
  counts: { create: number; update: number; delete: number };
  summary: string;
} {
  const rawChanges = Array.isArray(params?.changes)
    ? params.changes
    : Array.isArray(params?.edits)
      ? params.edits
      : [];
  const normalized = (rawChanges as any[])
    .map((entry: any) => ({
      path: extractApprovalPath(entry),
      kind: typeof entry?.kind === 'string'
        ? entry.kind
        : typeof entry?.type === 'string'
          ? entry.type
          : typeof entry?.changeType === 'string'
            ? entry.changeType
            : 'update',
    }))
    .filter((entry: { path: string | null }) => Boolean(entry.path));
  const paths = normalized
    .map((entry: { path: string | null }) => entry.path!)
    .filter((path: string, index: number, values: string[]) => values.indexOf(path) === index);
  const counts = {
    create: normalized.filter((entry: { kind: string }) => /^(create|add|new)$/i.test(entry.kind)).length,
    update: normalized.filter((entry: { kind: string }) => !/^(create|add|new|delete|remove)$/i.test(entry.kind)).length,
    delete: normalized.filter((entry: { kind: string }) => /^(delete|remove)$/i.test(entry.kind)).length,
  };
  const summary = paths.length > 0
    ? truncateInline(`${paths.length} file(s): ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', ...' : ''}`, 120)
    : 'Review proposed file changes';
  return { paths, counts, summary };
}

function extractApprovalPath(entry: any): string | null {
  const candidates = [
    entry?.path,
    entry?.filePath,
    entry?.target,
    entry?.newPath,
    entry?.oldPath,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function inferCommandApprovalRisk(commandText: string | null): PendingApprovalRecord['riskLevel'] {
  const normalized = (commandText ?? '').toLowerCase();
  if (!normalized) {
    return 'medium';
  }
  if (/(^|\s)(sudo|rm\s+-rf|git\s+reset\s+--hard|mkfs|dd\s+if=|shutdown|reboot)(\s|$)/.test(normalized)) {
    return 'high';
  }
  if (/(^|\s)(curl|wget|npm\s+(install|update)|pnpm\s+(install|update)|yarn\s+(add|install)|chmod|chown|docker|kubectl|terraform)(\s|$)/.test(normalized)) {
    return 'medium';
  }
  return 'low';
}

function inferFileChangeApprovalRisk(
  paths: string[],
  counts: { create: number; update: number; delete: number },
): PendingApprovalRecord['riskLevel'] {
  if (counts.delete > 0 || paths.some((path) => /(^|\/)(\.env|\.git|Dockerfile|docker-compose|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path))) {
    return 'high';
  }
  if (paths.length > 3 || counts.create > 0) {
    return 'medium';
  }
  return 'low';
}

function formatApprovalChangeCounts(locale: AppLocale, raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const counts = raw as { create?: unknown; update?: unknown; delete?: unknown };
  const parts: string[] = [];
  if (Number(counts.create || 0) > 0) {
    parts.push(locale === 'zh' ? `新增 ${Number(counts.create)} 个` : `${Number(counts.create)} create`);
  }
  if (Number(counts.update || 0) > 0) {
    parts.push(locale === 'zh' ? `修改 ${Number(counts.update)} 个` : `${Number(counts.update)} update`);
  }
  if (Number(counts.delete || 0) > 0) {
    parts.push(locale === 'zh' ? `删除 ${Number(counts.delete)} 个` : `${Number(counts.delete)} delete`);
  }
  return parts.length > 0 ? parts.join(locale === 'zh' ? '，' : ', ') : null;
}

function formatRateLimitStatusLines(locale: AppLocale, snapshot: AccountRateLimitSnapshot | null): string[] {
  if (!snapshot) {
    return [t(locale, 'status_rate_limits_unavailable')];
  }
  const lines = [
    t(locale, 'status_account_plan', { value: snapshot.planType ?? t(locale, 'unknown') }),
  ];
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window): window is NonNullable<AccountRateLimitSnapshot['primary']> => Boolean(window))
    .sort((left, right) => (left.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - (right.windowDurationMins ?? Number.MAX_SAFE_INTEGER));
  for (const window of windows) {
    lines.push(t(locale, 'status_rate_limit_window', {
      label: formatRateLimitWindowLabel(locale, window.windowDurationMins),
      used: window.usedPercent,
      reset: formatRateLimitResetAt(locale, window.resetsAt),
    }));
  }
  if (snapshot.credits && (snapshot.credits.unlimited || snapshot.credits.hasCredits || snapshot.credits.balance !== null)) {
    lines.push(t(locale, 'status_rate_limit_credits', {
      value: snapshot.credits.unlimited
        ? t(locale, 'status_rate_limit_unlimited')
        : snapshot.credits.balance ?? '0',
    }));
  }
  return lines;
}

function formatRateLimitWindowLabel(locale: AppLocale, windowDurationMins: number | null): string {
  if (windowDurationMins === 300) {
    return locale === 'zh' ? '5小时' : '5h';
  }
  if (windowDurationMins === 10080) {
    return locale === 'zh' ? '本周' : 'weekly';
  }
  if (windowDurationMins === null || !Number.isFinite(windowDurationMins) || windowDurationMins <= 0) {
    return t(locale, 'unknown');
  }
  if (windowDurationMins % 1440 === 0) {
    const days = Math.floor(windowDurationMins / 1440);
    return locale === 'zh' ? `${days}天` : `${days}d`;
  }
  if (windowDurationMins % 60 === 0) {
    const hours = Math.floor(windowDurationMins / 60);
    return locale === 'zh' ? `${hours}小时` : `${hours}h`;
  }
  return locale === 'zh' ? `${windowDurationMins}分钟` : `${windowDurationMins}m`;
}

function formatRateLimitResetAt(locale: AppLocale, resetsAt: number | null): string {
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return t(locale, 'unknown');
  }
  return new Date(resetsAt * 1000).toISOString();
}

function mapApprovalDecision(action: ApprovalAction): unknown {
  const decision = action === 'accept'
    ? 'accept'
    : action === 'session'
      ? 'acceptForSession'
      : 'decline';
  return { decision };
}

function buildThreadHistoryPreviewTurns(
  turns: AppThreadWithTurns['turns'],
  limit: number,
): ThreadHistoryPreviewTurn[] {
  const normalized: ThreadHistoryPreviewTurn[] = [];
  for (const turn of turns) {
    const previewTurn = normalizeThreadHistoryPreviewTurn(turn);
    if (previewTurn) {
      normalized.push(previewTurn);
    }
  }
  return normalized.slice(Math.max(0, normalized.length - limit));
}

function normalizeThreadHistoryPreviewTurn(turn: AppThreadTurn): ThreadHistoryPreviewTurn | null {
  const userText = findLastThreadTurnText(turn.items, isUserThreadTurnItem);
  const finalAssistantText = findLastThreadTurnText(turn.items, (item) => (
    isAssistantThreadTurnItem(item) && classifyAgentOutput(item.phase, true) === 'final_answer'
  ));
  const fallbackAssistantText = findLastThreadTurnText(turn.items, isAssistantThreadTurnItem);
  const assistantText = finalAssistantText ?? fallbackAssistantText ?? sanitizeThreadHistoryPreviewText(turn.error);
  if (!userText && !assistantText) {
    return null;
  }
  return {
    userText,
    assistantText,
    status: classifyThreadHistoryPreviewStatus(turn, Boolean(finalAssistantText), Boolean(fallbackAssistantText)),
  };
}

function classifyThreadHistoryPreviewStatus(
  turn: AppThreadTurn,
  hasFinalAssistantText: boolean,
  hasAssistantText: boolean,
): ThreadHistoryPreviewTurn['status'] {
  const normalizedStatus = normalizeHistoryStatus(turn.status);
  if (normalizedStatus.includes('interrupt') || normalizedStatus.includes('cancel')) {
    return 'interrupted';
  }
  if (normalizedStatus.includes('fail') || normalizedStatus.includes('error') || turn.error) {
    return 'failed';
  }
  if (hasFinalAssistantText) {
    return 'complete';
  }
  if (hasAssistantText) {
    return 'partial';
  }
  if (
    normalizedStatus.includes('active')
    || normalizedStatus.includes('pending')
    || normalizedStatus.includes('progress')
    || normalizedStatus.includes('running')
  ) {
    return 'partial';
  }
  return 'failed';
}

function findLastThreadTurnText(
  items: AppThreadTurnItem[],
  predicate: (item: AppThreadTurnItem) => boolean,
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || !predicate(item)) {
      continue;
    }
    const text = sanitizeThreadHistoryPreviewText(item.text);
    if (text) {
      return text;
    }
  }
  return null;
}

function isUserThreadTurnItem(item: AppThreadTurnItem): boolean {
  return normalizeThreadTurnItemType(item.type) === 'usermessage';
}

function isAssistantThreadTurnItem(item: AppThreadTurnItem): boolean {
  const type = normalizeThreadTurnItemType(item.type);
  return type === 'agentmessage' || type === 'assistantmessage';
}

function normalizeThreadTurnItemType(value: string): string {
  return value.replace(/[^a-z]/gi, '').toLowerCase();
}

function sanitizeThreadHistoryPreviewText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalizedValue = value.replace(/\r\n?/g, '\n').trim();
  if (!normalizedValue) {
    return null;
  }
  const lines = normalizedValue
    .split('\n')
    .map((line) => normalizeThreadHistoryText(stripTelegramHtml(line)))
    .filter((line): line is string => line !== null);
  if (lines.length === 0) {
    return null;
  }
  const hasPreviewShell = lines.some((line) => isThreadHistoryPreviewShellLine(line));
  const filteredLines = hasPreviewShell
    ? lines.filter((line) => !isThreadHistoryPreviewShellLine(line) && !isThreadHistoryPreviewSpeakerLine(line))
    : lines;
  if (filteredLines.length === 0) {
    return hasPreviewShell ? null : normalizeThreadHistoryText(normalizedValue);
  }
  return normalizeThreadHistoryText(filteredLines.join('\n\n'));
}

function normalizeThreadHistoryText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : null;
}

function stripTelegramHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

function isThreadHistoryPreviewShellLine(value: string): boolean {
  const normalized = normalizeHistoryPreviewLine(value);
  return normalized === 'recent context'
    || normalized === '最近会话'
    || normalized === 'recent turns'
    || normalized === 'recent turns:'
    || normalized === '最近几轮'
    || normalized === '最近几轮:'
    || normalized === '最近几轮：'
    || normalized.startsWith('switched to:')
    || normalized.startsWith('已切换到:')
    || normalized.startsWith('已切换到：')
    || normalized.startsWith('thread:')
    || normalized.startsWith('线程:')
    || normalized.startsWith('线程：')
    || /^turn \d+$/.test(normalized)
    || /^第 ?\d+ ?轮$/.test(normalized);
}

function isThreadHistoryPreviewSpeakerLine(value: string): boolean {
  const normalized = normalizeHistoryPreviewLine(value);
  return /^(you|你)\s*[:：]/.test(normalized)
    || /^codex(?:\s*[（(][^）)]*[）)])?\s*[:：]/.test(normalized);
}

function normalizeHistoryPreviewLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeHistoryStatus(value: string | null): string {
  return (value ?? '').replace(/[^a-z]/gi, '').toLowerCase();
}

function inferTelegramChatType(chatId: string): string {
  return String(chatId).startsWith('-') ? 'supergroup' : 'private';
}

function isPendingUserInputReview(record: PendingUserInputRecord): boolean {
  return record.currentQuestionIndex >= record.questions.length;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toErrorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error: String(error) };
}

function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isThreadNotFoundError(error: unknown): boolean {
  return error instanceof Error && /(thread not found|no rollout found for thread id)/i.test(error.message);
}

function isTelegramMessageGone(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message to delete not found')
    || message.includes('message to edit not found')
    || message.includes('message not found');
}
