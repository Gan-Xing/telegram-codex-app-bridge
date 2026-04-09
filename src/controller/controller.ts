import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { normalizeLocale, t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type {
  AppLocale,
  ModelInfo,
  PendingApprovalRecord,
  ReasoningEffortValue,
  RuntimeStatus,
  ThreadBinding,
  ThreadSessionState,
} from '../types.js';
import { parseCommand } from './commands.js';
import {
  buildAccessSettingsKeyboard,
  buildModelSettingsKeyboard,
  buildThreadsKeyboard,
  clampEffortToModel,
  formatAccessPresetLabel,
  formatAccessSettingsMessage,
  formatApprovalPolicyLabel,
  formatModelSettingsMessage,
  formatSandboxModeLabel,
  formatThreadsMessage,
  formatWeixinAccessCopyPaste,
  formatWeixinModelCopyPaste,
  formatWeixinThreadsCopyPaste,
  formatWeixinWhereNavCopyPaste,
  formatWhereMessage,
  normalizeRequestedEffort,
  resolveCurrentModel,
  resolveRequestedModel,
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
import {
  TELEGRAM_MESSAGE_LIMIT,
  chunkTelegramMessage,
  chunkTelegramStreamMessage,
  clipTelegramDraftMessage,
} from '../telegram/text.js';
import { isDefaultTelegramScope, resolveTelegramAddressing } from '../telegram/addressing.js';
import { BridgeMessagingRouter } from '../channels/bridge_messaging_router.js';
import { BRIDGE_SCOPE_WEIXIN_PREFIX, parseWeixinBridgeScope } from '../core/bridge_scope.js';
import { resolveTelegramRenderRoute, type TelegramRenderRoute } from '../telegram/rendering.js';
import type { CodexAppClient, JsonRpcNotification, JsonRpcServerRequest, TurnInput } from '../codex_app/client.js';
import {
  normalizeTurnActivityEvent,
  type RawExecCommandEvent,
  type TurnActivityEvent,
  type TurnOutputKind,
} from './activity.js';
import { normalizeAccessPreset, resolveAccessMode } from './access.js';
import { diffObservedTurn, findLatestTurn, findLiveTurn, type ObservedTurnCursor } from './observer.js';
import {
  applySessionLog,
  bootstrapSessionLog,
  splitJsonlChunk,
  type SessionLogCursor,
} from './session_observer.js';
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

interface ActiveTurn {
  scopeId: string;
  chatId: string;
  topicId: number | null;
  renderRoute: TelegramRenderRoute;
  isObserved: boolean;
  threadId: string;
  turnId: string;
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
  toolBatch: ToolBatchState | null;
  pendingArchivedStatus: ArchivedStatusContent | null;
  renderRetryTimer: NodeJS.Timeout | null;
  lastStreamFlushAt: number;
  renderRequested: boolean;
  forceStatusFlush: boolean;
  forceStreamFlush: boolean;
  renderTask: Promise<void> | null;
  completion: Promise<void>;
  archivedMessageIds: number[];
  resolver: () => void;
}

interface ObservedThreadWatcher {
  scopeId: string;
  chatId: string;
  chatType: string;
  topicId: number | null;
  threadId: string;
  mode: 'app_snapshot' | 'session_file';
  timer: NodeJS.Timeout | null;
  cursor: ObservedTurnCursor | null;
  activeTurnId: string | null;
  waitingOnApproval: boolean;
  sessionPath: string | null;
  sessionOffset: number;
  sessionRemainder: string;
  sessionCursor: SessionLogCursor;
  stopped: boolean;
}

interface QueuedPromptRequest {
  event: TelegramTextEvent;
  text: string;
}

type ApprovalAction = 'accept' | 'session' | 'deny';
class UserFacingError extends Error {}
const OBSERVED_THREAD_POLL_MS = 1500;
const OBSERVED_CLI_USER_LABEL = 'codex-cli-user';

export class BridgeSessionCore {
  private activeTurns = new Map<string, ActiveTurn>();
  private observedThreadWatchers = new Map<string, ObservedThreadWatcher>();
  private queuedPrompts = new Map<string, QueuedPromptRequest>();
  private locks = new Map<string, Promise<void>>();
  private approvalTimers = new Map<string, NodeJS.Timeout>();
  private attachedThreads = new Set<string>();
  private botUsername: string | null = null;
  private lastError: string | null = null;
  private readonly messaging: BridgeMessagingRouter;

  constructor(
    private readonly config: AppConfig,
    private readonly store: BridgeStore,
    private readonly logger: Logger,
    private readonly bot: TelegramGateway,
    private readonly app: CodexAppClient,
    outbound: BridgeMessagingRouter,
  ) {
    this.messaging = outbound;
  }

  /** Wire Telegram inbound events. Call before {@link startCodexApp}. */
  registerTelegramInboundHandlers(): void {
    this.bot.on('text', (event: TelegramTextEvent) => {
      void this.withLock(event.scopeId, async () => this.handleText(event)).catch((error) => {
        void this.handleAsyncError('telegram.text', error, event.scopeId);
      });
    });
    this.bot.on('callback', (event: TelegramCallbackEvent) => {
      void this.handleCallback(event).catch((error) => {
        void this.handleAsyncError('telegram.callback', error, event.scopeId);
      });
    });
  }

  /**
   * Deliver an inbound user message through the same pipeline as Telegram `text` events
   * (used by the Weixin adapter).
   */
  dispatchInboundLikeTelegramText(event: TelegramTextEvent): void {
    void this.withLock(event.scopeId, async () => this.handleText(event)).catch((error) => {
      void this.handleAsyncError('channel.text', error, event.scopeId);
    });
  }

  /** Start Codex app-server transport and attach RPC listeners. */
  async startCodexApp(): Promise<void> {
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
      this.queuedPrompts.clear();
      this.clearObservedThreadWatchers();
      void this.abandonActiveTurns().catch((error) => {
        this.logger.error('codex.disconnect_cleanup_failed', { error: toErrorMeta(error) });
      });
      this.updateStatus();
    });

    await this.app.start();
    await this.cleanupStaleTurnPreviews();
    this.updateStatus();
  }

  /** Begin Telegram Bot API long-polling after handlers and Codex are ready. */
  async startTelegramPolling(): Promise<void> {
    await this.bot.start();
    this.botUsername = this.bot.username;
    this.updateStatus();
  }

  /** Telegram-only default startup (single channel). */
  async start(): Promise<void> {
    this.registerTelegramInboundHandlers();
    await this.startCodexApp();
    await this.startTelegramPolling();
  }

  async stop(): Promise<void> {
    this.queuedPrompts.clear();
    this.clearObservedThreadWatchers();
    await this.abandonActiveTurns();
    this.bot.stop();
    for (const timer of this.approvalTimers.values()) {
      clearTimeout(timer);
    }
    this.approvalTimers.clear();
    await this.app.stop();
    this.updateStatus();
  }

  getRuntimeStatus(): RuntimeStatus {
    return {
      running: true,
      connected: this.app.isConnected(),
      userAgent: this.app.getUserAgent(),
      botUsername: this.botUsername,
      currentBindings: this.store.countBindings(),
      pendingApprovals: this.store.countPendingApprovals(),
      activeTurns: this.activeTurns.size,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
      channels: {
        telegram: true,
        weixin: Boolean(this.config.wxEnabled && this.messaging.hasWeixinTransport),
      },
    };
  }

  private async handleText(event: TelegramTextEvent): Promise<void> {
    const scopeId = event.scopeId;
    const locale = this.localeForChat(scopeId, event.languageCode);
    if (scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX)) {
      this.store.insertAudit('inbound', scopeId, 'weixin.message', summarizeTelegramInput(event.text, event.attachments));
      const command = event.attachments.length === 0 ? parseCommand(event.text) : null;
      if (command) {
        await this.handleCommand(event, locale, command.name, command.args);
        return;
      }
      if (this.findActiveTurn(scopeId)) {
        await this.sendMessage(scopeId, t(locale, 'another_turn_running'));
        return;
      }
      await this.startBoundTurnFromEvent(event, locale, event.text.trim());
      return;
    }
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

    if (this.findActiveTurn(scopeId)) {
      await this.sendMessage(scopeId, t(locale, 'another_turn_running'));
      return;
    }

    await this.startBoundTurnFromEvent(event, locale, decision.text);
  }

  private async handleCommand(event: TelegramTextEvent, locale: AppLocale, name: string, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    switch (name) {
      case 'start':
      case 'help': {
        const weixinNote = scopeId.startsWith(BRIDGE_SCOPE_WEIXIN_PREFIX) ? t(locale, 'help_weixin_note') : '';
        const lines = [
          t(locale, 'help_commands_title'),
          '/help',
          '/status',
          '/threads [query]',
          '/open <n>',
          '/watch',
          '/unwatch',
          '/takeover <message>',
          '/queue <message>',
          '/new [cwd]',
          '/models',
          '/permissions',
          '/permissions <read-only|default|full-access>',
          '/reveal',
          '/where',
          '/interrupt',
          t(locale, 'help_advanced_aliases'),
          t(locale, 'help_plain_text_hint'),
        ];
        if (weixinNote) {
          lines.push('', weixinNote);
        }
        await this.sendMessage(scopeId, lines.join('\n'));
        return;
      }
      case 'status': {
        const binding = this.store.getBinding(scopeId);
        const settings = this.store.getChatSettings(scopeId);
        const access = this.resolveEffectiveAccess(scopeId, settings);
        const lines = [
          t(locale, 'status_connected', { value: t(locale, this.app.isConnected() ? 'yes' : 'no') }),
          t(locale, 'status_user_agent', { value: this.app.getUserAgent() ?? t(locale, 'unknown') }),
          t(locale, 'status_current_thread', { value: binding?.threadId ?? t(locale, 'none') }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
          t(locale, 'status_access_preset', { value: formatAccessPresetLabel(locale, access.preset) }),
          t(locale, 'status_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy) }),
          t(locale, 'status_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode) }),
          t(locale, 'status_sync_on_open', { value: t(locale, this.config.codexAppSyncOnOpen ? 'yes' : 'no') }),
          t(locale, 'status_sync_on_turn_complete', { value: t(locale, this.config.codexAppSyncOnTurnComplete ? 'yes' : 'no') }),
          t(locale, 'status_pending_approvals', { value: this.store.countPendingApprovals() }),
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
        this.queuedPrompts.delete(scopeId);
        await this.stopWatchingScopeThread(scopeId, thread.threadId);
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
        return;
      }
      case 'watch': {
        const binding = this.store.getBinding(scopeId);
        if (!binding) {
          await this.sendMessage(scopeId, t(locale, 'watch_no_thread_bound'));
          return;
        }
        const watch = await this.watchThread(scopeId, event.chatId, event.chatType, event.topicId, binding);
        const watchedThreadId = watch.threadId;
        const mode = watch.mode;
        if (mode === 'already') {
          await this.sendMessage(scopeId, t(locale, 'watch_already_enabled', { threadId: watchedThreadId }));
          return;
        }
        if (mode === 'active') {
          await this.sendMessage(scopeId, t(locale, 'watch_started_active', { threadId: watchedThreadId }));
          return;
        }
        await this.sendMessage(scopeId, t(locale, 'watch_started_idle', { threadId: watchedThreadId }));
        return;
      }
      case 'unwatch': {
        const watchedThreadId = await this.unwatchThread(scopeId);
        if (!watchedThreadId) {
          await this.sendMessage(scopeId, t(locale, 'watch_not_enabled'));
          return;
        }
        await this.sendMessage(scopeId, t(locale, 'watch_stopped', { threadId: watchedThreadId }));
        return;
      }
      case 'takeover': {
        await this.handleTakeoverCommand(event, locale, args);
        return;
      }
      case 'queue': {
        await this.handleQueueCommand(event, locale, args);
        return;
      }
      case 'new': {
        const cwd = args.join(' ').trim() || this.config.defaultCwd;
        this.queuedPrompts.delete(scopeId);
        await this.stopWatchingScopeThread(scopeId);
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
      case 'permissions':
      case 'access': {
        const accessArg = args.join(' ').trim();
        if (accessArg) {
          const preset = normalizeAccessPreset(accessArg);
          if (!preset) {
            await this.sendMessage(
              scopeId,
              t(locale, 'usage_access_preset', { value: accessArg }),
            );
            return;
          }
          this.store.setChatAccessPreset(scopeId, preset);
          await this.sendMessage(
            scopeId,
            t(locale, 'access_preset_configured', { value: formatAccessPresetLabel(locale, preset) }),
          );
          return;
        }
        await this.showAccessSettingsPanel(scopeId, undefined, locale);
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
    const navMatch = /^nav:(models|threads|reveal|permissions)$/.exec(event.data);
    if (navMatch) {
      await this.handleNavigationCallback(event, navMatch[1]! as 'models' | 'threads' | 'reveal' | 'permissions', locale);
      return;
    }
    const settingsMatch = /^settings:(model|effort|access):(.+)$/.exec(event.data);
    if (settingsMatch) {
      await this.handleSettingsCallback(event, settingsMatch[1]! as 'model' | 'effort' | 'access', settingsMatch[2]!, locale);
      return;
    }
    const match = /^approval:([a-f0-9]+):(accept|session|deny)$/.exec(event.data);
    if (!match) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    const localId = match[1]!;
    const action = match[2]! as ApprovalAction;
    const approval = this.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'approval_already_resolved'));
      return;
    }
    if (approval.chatId !== scopeId || (approval.messageId !== null && approval.messageId !== event.messageId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'approval_mismatch'));
      return;
    }

    const result = mapApprovalDecision(action);
    await this.app.respond(approval.serverRequestId, result);
    this.store.markApprovalResolved(localId);
    this.clearApprovalTimer(localId);
    await this.clearPendingApprovalStatus(approval.threadId, approval.kind);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
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
        const scopeId = this.findChatByThread(params.threadId);
        if (scopeId) {
          await this.sendMessage(scopeId, t(this.localeForChat(scopeId), 'interactive_input_unsupported'));
        }
        await this.app.respond(request.id, { answers: {} });
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

  private async startTurnWithRecovery(scopeId: string, binding: Pick<ThreadBinding, 'threadId' | 'cwd'>, input: TurnInput[]): Promise<{ threadId: string; turnId: string }> {
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    try {
      const turn = await this.app.startTurn({
        threadId: binding.threadId,
        input,
        approvalPolicy: access.approvalPolicy,
        sandboxMode: access.sandboxMode,
        cwd: binding.cwd ?? this.config.defaultCwd,
        model: settings?.model ?? null,
        effort: settings?.reasoningEffort ?? null,
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
      const turn = await this.app.startTurn({
        threadId: replacement.threadId,
        input,
        approvalPolicy: nextAccess.approvalPolicy,
        sandboxMode: nextAccess.sandboxMode,
        cwd: replacement.cwd ?? this.config.defaultCwd,
        model: nextSettings?.model ?? null,
        effort: nextSettings?.reasoningEffort ?? null,
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

  private async stageAttachments(
    cwd: string,
    threadId: string,
    attachments: readonly TelegramInboundAttachment[],
    locale: AppLocale,
  ): Promise<StagedTelegramAttachment[]> {
    const staged: StagedTelegramAttachment[] = [];
    for (const attachment of attachments) {
      try {
        if (attachment.localPath) {
          const planned = planAttachmentStoragePath(
            cwd,
            threadId,
            attachment,
            path.basename(attachment.localPath),
          );
          await fs.mkdir(path.dirname(planned.localPath), { recursive: true });
          await fs.copyFile(attachment.localPath, planned.localPath);
          const stat = await fs.stat(planned.localPath);
          const resolvedSize = stat.size;
          if (resolvedSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES) {
            throw new UserFacingError(t(locale, 'attachment_too_large', {
              name: attachment.fileName ?? attachment.fileUniqueId,
              size: resolvedSize,
            }));
          }
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
          continue;
        }
        const remoteFile = await this.messaging.getFile(attachment.fileId);
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
        await this.messaging.downloadResolvedFile(remoteFile.file_path, planned.localPath);
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
  ): Promise<void> {
    const active = this.createActiveTurnState(
      scopeId,
      chatId,
      chatType,
      topicId,
      threadId,
      turnId,
      previewMessageId,
    );
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
  }

  private createActiveTurnState(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    threadId: string,
    turnId: string,
    previewMessageId: number,
    isObserved = false,
  ): ActiveTurn {
    let resolver: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    return {
      scopeId,
      chatId,
      topicId,
      renderRoute: resolveTelegramRenderRoute(chatType, topicId),
      isObserved,
      threadId,
      turnId,
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
      toolBatch: null,
      pendingArchivedStatus: null,
      renderRetryTimer: null,
      lastStreamFlushAt: 0,
      renderRequested: false,
      forceStatusFlush: false,
      forceStreamFlush: false,
      renderTask: null,
      completion,
      archivedMessageIds: [],
      resolver,
    };
  }

  private async completeTurn(active: ActiveTurn): Promise<void> {
    const locale = this.localeForChat(active.scopeId);
    let shouldMarkPartialOutput = false;
    try {
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
  }

  private async handleTurnActivityEvent(activity: TurnActivityEvent): Promise<void> {
    const active = this.activeTurns.get(activity.turnId);
    if (!active) {
      return;
    }

    switch (activity.kind) {
      case 'user_message': {
        await this.sendObservedCliUserMessage(active.scopeId, activity.text);
        return;
      }
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
        const scopeId = active.scopeId;
        try {
          this.promoteReadyToolBatch(active);
          await this.completeTurn(active);
          await this.cleanupObservedTransientMessages(active);
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
          this.clearObservedTurnWatcher(active.turnId);
          active.resolver();
          this.activeTurns.delete(active.turnId);
          this.updateStatus();
          await this.withLock(scopeId, async () => this.startQueuedPromptIfPresent(scopeId));
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
      command: params.command ? String(params.command) : null,
      cwd: params.cwd ? String(params.cwd) : null,
      messageId: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.store.savePendingApproval(record);
    return record;
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
    return this.messaging.sendPlain(scopeId, text, inlineKeyboard);
  }

  private async sendHtmlMessage(
    scopeId: string,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<number> {
    return this.messaging.sendHtml(scopeId, text, inlineKeyboard);
  }

  private async editMessage(
    scopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    await this.messaging.editPlain(scopeId, messageId, text, inlineKeyboard);
  }

  private async editHtmlMessage(
    scopeId: string,
    messageId: number,
    text: string,
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    await this.messaging.editHtml(scopeId, messageId, text, inlineKeyboard);
  }

  private async deleteMessage(scopeId: string, messageId: number): Promise<void> {
    await this.messaging.deleteMessage(scopeId, messageId);
  }

  private async sendTyping(scopeId: string): Promise<void> {
    await this.messaging.sendTypingInScope(scopeId);
  }

  private async sendObservedCliUserMessage(scopeId: string, text: string): Promise<void> {
    const chunks = chunkTelegramMessage(text, TELEGRAM_MESSAGE_LIMIT - 64, '');
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const body = index === 0
        ? `<b>${escapeTelegramHtml(OBSERVED_CLI_USER_LABEL)}</b>\n<pre>${escapeTelegramHtml(chunk)}</pre>`
        : `<pre>${escapeTelegramHtml(chunk)}</pre>`;
      await this.sendHtmlMessage(scopeId, body);
    }
  }

  private async cleanupObservedTransientMessages(active: ActiveTurn): Promise<void> {
    if (!active.isObserved || !this.hasObservedPersistentReply(active)) {
      return;
    }

    const messageIds = new Set<number>();
    for (const segment of active.segments) {
      if (segment.outputKind === 'final_answer') {
        continue;
      }
      for (const message of segment.messages) {
        messageIds.add(message.messageId);
      }
    }
    for (const messageId of active.archivedMessageIds) {
      messageIds.add(messageId);
    }

    for (const messageId of messageIds) {
      try {
        await this.deleteMessage(active.scopeId, messageId);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.logger.warn('telegram.observed_cleanup_delete_failed', {
            error: String(error),
            turnId: active.turnId,
            messageId,
          });
        }
      }
    }
  }

  private hasObservedPersistentReply(active: ActiveTurn): boolean {
    if ((active.finalText || '').trim()) {
      return true;
    }
    return active.segments.some((segment) => (
      segment.outputKind === 'final_answer' && ((segment.text || '').trim().length > 0 || segment.messages.length > 0)
    ));
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

  private clearObservedThreadWatchers(): void {
    for (const watcher of this.observedThreadWatchers.values()) {
      watcher.stopped = true;
      if (watcher.timer) {
        clearTimeout(watcher.timer);
        watcher.timer = null;
      }
    }
    this.observedThreadWatchers.clear();
  }

  private clearObservedTurnWatcher(turnId: string): void {
    for (const watcher of this.observedThreadWatchers.values()) {
      if (watcher.activeTurnId === turnId) {
        watcher.activeTurnId = null;
        if (watcher.mode === 'app_snapshot') {
          watcher.cursor = null;
        }
        watcher.waitingOnApproval = false;
        watcher.sessionCursor = { activeTurnId: null, nextMessageIndex: 0 };
      }
    }
  }

  private async stopWatchingScopeThread(scopeId: string, nextThreadId?: string): Promise<void> {
    const watcher = this.observedThreadWatchers.get(scopeId);
    if (!watcher) {
      return;
    }
    if (nextThreadId && watcher.threadId === nextThreadId) {
      return;
    }
    watcher.stopped = true;
    if (watcher.timer) {
      clearTimeout(watcher.timer);
      watcher.timer = null;
    }
    this.observedThreadWatchers.delete(scopeId);

    if (!watcher.activeTurnId) {
      return;
    }
    const active = this.activeTurns.get(watcher.activeTurnId);
    if (!active) {
      return;
    }
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
    this.updateStatus();
  }

  private async unwatchThread(scopeId: string): Promise<string | null> {
    const watcher = this.observedThreadWatchers.get(scopeId);
    if (!watcher) {
      return null;
    }
    const threadId = watcher.threadId;
    await this.stopWatchingScopeThread(scopeId);
    return threadId;
  }

  private async watchThread(
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    binding: ThreadBinding,
  ): Promise<{ mode: 'already' | 'active' | 'idle'; threadId: string }> {
    let thread = await this.app.readThread(binding.threadId, false);
    let threadId = binding.threadId;
    let watchMode: ObservedThreadWatcher['mode'] = 'session_file';
    let sessionPath: string | null = null;

    if (thread?.source === 'cli' && thread.path) {
      sessionPath = thread.path;
    } else {
      const readyBinding = await this.ensureThreadReady(scopeId, binding);
      threadId = readyBinding.threadId;
      thread = await this.app.readThread(threadId, false);
      watchMode = 'app_snapshot';
    }

    const existing = this.observedThreadWatchers.get(scopeId);
    if (existing && existing.threadId === threadId && existing.mode === watchMode && !existing.stopped) {
      return { mode: 'already', threadId };
    }
    await this.stopWatchingScopeThread(scopeId, threadId);
    const watcher: ObservedThreadWatcher = {
      scopeId,
      chatId,
      chatType,
      topicId,
      threadId,
      mode: watchMode,
      timer: null,
      cursor: null,
      activeTurnId: null,
      waitingOnApproval: false,
      sessionPath,
      sessionOffset: -1,
      sessionRemainder: '',
      sessionCursor: { activeTurnId: null, nextMessageIndex: 0 },
      stopped: false,
    };
    this.observedThreadWatchers.set(scopeId, watcher);
    const mode = await this.pollObservedThread(watcher);
    this.scheduleObservedThreadPoll(watcher);
    return { mode, threadId };
  }

  private scheduleObservedThreadPoll(watcher: ObservedThreadWatcher): void {
    if (watcher.stopped) {
      return;
    }
    watcher.timer = setTimeout(() => {
      watcher.timer = null;
      void this.pollObservedThread(watcher).catch((error) => {
        this.logger.error('codex.observe_thread_failed', {
          scopeId: watcher.scopeId,
          threadId: watcher.threadId,
          error: toErrorMeta(error),
        });
      }).finally(() => {
        if (!watcher.stopped && this.observedThreadWatchers.get(watcher.scopeId) === watcher) {
          this.scheduleObservedThreadPoll(watcher);
        }
      });
    }, OBSERVED_THREAD_POLL_MS);
  }

  private async pollObservedThread(watcher: ObservedThreadWatcher): Promise<'active' | 'idle'> {
    if (watcher.stopped) {
      return 'idle';
    }
    if (watcher.mode === 'session_file') {
      return this.pollObservedSessionFile(watcher);
    }
    const snapshot = await this.app.readThreadSnapshot(watcher.threadId);
    if (!snapshot) {
      await this.stopWatchingScopeThread(watcher.scopeId);
      return 'idle';
    }

    const liveTurn = findLiveTurn(snapshot);
    const latestTurn = findLatestTurn(snapshot);
    if (!liveTurn) {
      if (watcher.activeTurnId && latestTurn && latestTurn.turnId === watcher.activeTurnId) {
        const active = this.activeTurns.get(watcher.activeTurnId);
        if (active) {
          await this.applyObservedTurnSnapshot(watcher, active, latestTurn, false);
          await this.handleTurnActivityEvent({
            kind: 'turn_completed',
            turnId: active.turnId,
            state: 'completed',
          });
        }
      }
      if (watcher.activeTurnId) {
        const staleActive = this.activeTurns.get(watcher.activeTurnId);
        if (staleActive) {
          staleActive.resolver();
          this.activeTurns.delete(staleActive.turnId);
          this.updateStatus();
        }
      }
      watcher.activeTurnId = null;
      watcher.cursor = null;
      watcher.waitingOnApproval = false;
      return 'idle';
    }

    let active = watcher.activeTurnId ? this.activeTurns.get(watcher.activeTurnId) ?? null : null;
    if (!active || watcher.activeTurnId !== liveTurn.turnId) {
      if (watcher.activeTurnId && watcher.activeTurnId !== liveTurn.turnId) {
        const staleActive = this.activeTurns.get(watcher.activeTurnId);
        if (staleActive) {
          staleActive.resolver();
          this.activeTurns.delete(staleActive.turnId);
        }
      }
      active = this.createActiveTurnState(
        watcher.scopeId,
        watcher.chatId,
        watcher.chatType,
        watcher.topicId,
        watcher.threadId,
        liveTurn.turnId,
        0,
        true,
      );
      this.activeTurns.set(liveTurn.turnId, active);
      watcher.activeTurnId = liveTurn.turnId;
      watcher.cursor = null;
      watcher.waitingOnApproval = false;
      this.updateStatus();
      await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    }

    await this.applyObservedTurnSnapshot(
      watcher,
      active,
      liveTurn,
      snapshot.activeFlags.includes('waitingOnApproval'),
    );
    return 'active';
  }

  private async pollObservedSessionFile(watcher: ObservedThreadWatcher): Promise<'active' | 'idle'> {
    if (!watcher.sessionPath) {
      return 'idle';
    }

    if (watcher.sessionOffset < 0) {
      let text: string;
      try {
        text = await fs.readFile(watcher.sessionPath, 'utf8');
      } catch (error) {
        if (isFileMissingError(error)) {
          await this.stopWatchingScopeThread(watcher.scopeId);
          return 'idle';
        }
        throw error;
      }
      const split = splitJsonlChunk('', text);
      const bootstrap = bootstrapSessionLog(split.lines);
      watcher.sessionOffset = Buffer.byteLength(text);
      watcher.sessionRemainder = split.remainder;
      watcher.sessionCursor = bootstrap.cursor;
      if (bootstrap.startedTurnId) {
        await this.ensureObservedActiveTurnState(watcher, bootstrap.startedTurnId);
      } else {
        watcher.activeTurnId = null;
      }
      await this.applyObservedSessionEvents(watcher, bootstrap.events);
      return watcher.sessionCursor.activeTurnId ? 'active' : 'idle';
    }

    const stats = await fs.stat(watcher.sessionPath).catch((error) => {
      if (isFileMissingError(error)) {
        return null;
      }
      throw error;
    });
    if (!stats) {
      await this.stopWatchingScopeThread(watcher.scopeId);
      return 'idle';
    }

    if (stats.size < watcher.sessionOffset) {
      watcher.sessionOffset = -1;
      watcher.sessionRemainder = '';
      watcher.sessionCursor = { activeTurnId: null, nextMessageIndex: 0 };
      return this.pollObservedSessionFile(watcher);
    }

    if (stats.size === watcher.sessionOffset) {
      return watcher.sessionCursor.activeTurnId ? 'active' : 'idle';
    }

    const handle = await fs.open(watcher.sessionPath, 'r');
    let chunk = '';
    try {
      const length = stats.size - watcher.sessionOffset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, watcher.sessionOffset);
      chunk = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }

    watcher.sessionOffset = stats.size;
    const split = splitJsonlChunk(watcher.sessionRemainder, chunk);
    watcher.sessionRemainder = split.remainder;
    const diff = applySessionLog(split.lines, watcher.sessionCursor);
    watcher.sessionCursor = diff.cursor;

    for (const turnId of diff.startedTurnIds) {
      await this.ensureObservedActiveTurnState(watcher, turnId);
    }
    await this.applyObservedSessionEvents(watcher, diff.events);
    return watcher.sessionCursor.activeTurnId ? 'active' : 'idle';
  }

  private async ensureObservedActiveTurnState(watcher: ObservedThreadWatcher, turnId: string): Promise<ActiveTurn> {
    const existing = this.activeTurns.get(turnId);
    if (existing) {
      watcher.activeTurnId = turnId;
      return existing;
    }

    if (watcher.activeTurnId && watcher.activeTurnId !== turnId) {
      const staleActive = this.activeTurns.get(watcher.activeTurnId);
      if (staleActive) {
        staleActive.resolver();
        this.activeTurns.delete(staleActive.turnId);
      }
    }

    const active = this.createActiveTurnState(
      watcher.scopeId,
      watcher.chatId,
      watcher.chatType,
      watcher.topicId,
      watcher.threadId,
      turnId,
      0,
      true,
    );
    this.activeTurns.set(turnId, active);
    watcher.activeTurnId = turnId;
    this.updateStatus();
    await this.queueTurnRender(active, { forceStatus: true, forceStream: true });
    return active;
  }

  private async applyObservedSessionEvents(
    watcher: ObservedThreadWatcher,
    events: TurnActivityEvent[],
  ): Promise<void> {
    for (const event of events) {
      if (!this.activeTurns.has(event.turnId)) {
        await this.ensureObservedActiveTurnState(watcher, event.turnId);
      }
      await this.handleTurnActivityEvent(event);
    }
  }

  private async applyObservedTurnSnapshot(
    watcher: ObservedThreadWatcher,
    active: ActiveTurn,
    turn: { turnId: string; status: string; items: any[]; error: string | null },
    waitingOnApproval: boolean,
  ): Promise<void> {
    const diff = diffObservedTurn(watcher.cursor, turn, waitingOnApproval);
    watcher.cursor = diff.nextCursor;
    if (watcher.waitingOnApproval !== diff.waitingOnApproval) {
      watcher.waitingOnApproval = diff.waitingOnApproval;
      if (diff.waitingOnApproval) {
        active.pendingApprovalKinds.add('command');
      } else {
        active.pendingApprovalKinds.delete('command');
      }
      await this.queueTurnRender(active, { forceStatus: true });
    }
    for (const event of diff.events) {
      await this.handleTurnActivityEvent(event);
    }
  }

  private async handleTakeoverCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    const nextPrompt = args.join(' ').trim();
    if (!nextPrompt) {
      await this.sendMessage(scopeId, t(locale, 'usage_takeover'));
      return;
    }

    this.queuedPrompts.delete(scopeId);
    const active = this.findActiveTurn(scopeId);
    if (active) {
      if (!active.interruptRequested) {
        await this.requestInterrupt(active);
      }
      await this.sendMessage(scopeId, t(locale, 'interrupt_requested_waiting'));
      await active.completion;
    }

    await this.startBoundTurnFromEvent(event, locale, nextPrompt);
  }

  private async handleQueueCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    const nextPrompt = args.join(' ').trim();
    if (!nextPrompt) {
      await this.sendMessage(scopeId, t(locale, 'usage_queue'));
      return;
    }

    if (!this.findActiveTurn(scopeId)) {
      await this.startBoundTurnFromEvent(event, locale, nextPrompt);
      return;
    }

    const replaced = this.queuedPrompts.has(scopeId);
    this.queuedPrompts.set(scopeId, { event, text: nextPrompt });
    await this.sendMessage(scopeId, t(locale, replaced ? 'queued_prompt_replaced' : 'queued_prompt_set'));
  }

  private async startQueuedPromptIfPresent(scopeId: string): Promise<void> {
    if (this.findActiveTurn(scopeId)) {
      return;
    }
    const queued = this.queuedPrompts.get(scopeId);
    if (!queued) {
      return;
    }
    this.queuedPrompts.delete(scopeId);
    await this.startBoundTurnFromEvent(
      queued.event,
      this.localeForChat(scopeId, queued.event.languageCode),
      queued.text,
    );
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
    await this.stopWatchingScopeThread(scopeId, threadId);
    let binding: ThreadBinding;
    try {
      binding = await this.bindCachedThread(scopeId, threadId);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'thread_no_longer_available'));
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
    await this.messaging.answerCallback(event.callbackQueryId, callbackText);
  }

  private async handleTurnInterruptCallback(event: TelegramCallbackEvent, turnId: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    const active = this.activeTurns.get(turnId);
    if (!active || active.scopeId !== scopeId) {
      await this.cleanupStaleInterruptButton(scopeId, event.messageId, locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'turn_already_finished'));
      return;
    }
    if (active.interruptRequested) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'interrupt_already_requested'));
      return;
    }
    active.interruptRequested = true;
    try {
      await this.requestInterrupt(active);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'interrupt_requested'));
    } catch (error) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'interrupt_failed', { error: formatUserError(error) }));
    }
  }

  private async handleNavigationCallback(
    event: TelegramCallbackEvent,
    target: 'models' | 'threads' | 'reveal' | 'permissions',
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if (target === 'models') {
      await this.showModelSettingsPanel(scopeId, event.messageId, locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'opened_model_settings'));
      return;
    }
    if (target === 'permissions') {
      await this.showAccessSettingsPanel(scopeId, event.messageId, locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'opened_access_settings'));
      return;
    }
    if (target === 'threads') {
      await this.showThreadsPanel(scopeId, event.messageId, undefined, locale);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'opened_thread_list'));
      return;
    }

    const binding = this.store.getBinding(scopeId);
    if (!binding) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'no_thread_bound_callback'));
      return;
    }
    const readyBinding = await this.ensureThreadReady(scopeId, binding);
    const revealError = await this.tryRevealThread(scopeId, readyBinding.threadId, 'reveal');
    await this.messaging.answerCallback(event.callbackQueryId, revealError ? t(locale, 'reveal_failed', { error: revealError }) : t(locale, 'opened_in_codex_short'));
  }

  private async showWherePanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const binding = this.store.getBinding(scopeId);
    const settings = this.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    if (!binding) {
      let text = [
        t(locale, 'where_no_thread_bound'),
        t(locale, 'where_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
        t(locale, 'where_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
        t(locale, 'where_access_preset', { value: formatAccessPresetLabel(locale, access.preset) }),
        t(locale, 'where_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy) }),
        t(locale, 'where_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode) }),
        t(locale, 'where_send_message_or_new'),
      ].join('\n');
      if (parseWeixinBridgeScope(scopeId)) {
        text += `\n\n${formatWeixinWhereNavCopyPaste(locale, false)}`;
      }
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
      let text = t(locale, 'where_thread_unavailable', { threadId: readyBinding.threadId });
      if (parseWeixinBridgeScope(scopeId)) {
        text += `\n\n${formatWeixinWhereNavCopyPaste(locale, true)}`;
      }
      if (messageId !== undefined) {
        await this.editMessage(scopeId, messageId, text, whereKeyboard(locale, false));
        return;
      }
      await this.sendMessage(scopeId, text, whereKeyboard(locale, false));
      return;
    }

    let text = formatWhereMessage(locale, thread, settings, this.config.defaultCwd, access);
    if (parseWeixinBridgeScope(scopeId)) {
      text += `\n\n${formatWeixinWhereNavCopyPaste(locale, true)}`;
    }
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
      name: thread.name,
      preview: thread.preview,
      cwd: thread.cwd,
      modelProvider: thread.modelProvider,
      status: thread.status,
      updatedAt: thread.updatedAt,
    }));
    this.store.cacheThreadList(scopeId, cached);
    let text = formatThreadsMessage(locale, cached, binding?.threadId ?? null, searchTerm ?? null);
    if (parseWeixinBridgeScope(scopeId)) {
      const rows = cached.map((row) => ({
        threadId: row.threadId,
        name: row.name,
        preview: row.preview,
      }));
      text += `\n\n${formatWeixinThreadsCopyPaste(locale, rows, searchTerm ?? null)}`;
    }
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
    let text = formatModelSettingsMessage(locale, models, settings);
    if (parseWeixinBridgeScope(scopeId)) {
      text += `\n\n${formatWeixinModelCopyPaste(locale, models, settings)}`;
    }
    const keyboard = buildModelSettingsKeyboard(locale, models, settings);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
  }

  private async showAccessSettingsPanel(scopeId: string, messageId?: number, locale = this.localeForChat(scopeId)): Promise<void> {
    const access = this.resolveEffectiveAccess(scopeId);
    let text = formatAccessSettingsMessage(locale, access);
    if (parseWeixinBridgeScope(scopeId)) {
      text += `\n\n${formatWeixinAccessCopyPaste(locale)}`;
    }
    const keyboard = buildAccessSettingsKeyboard(locale, access);
    if (messageId !== undefined) {
      await this.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.sendHtmlMessage(scopeId, text, keyboard);
  }

  private async handleSettingsCallback(
    event: TelegramCallbackEvent,
    kind: 'model' | 'effort' | 'access',
    rawValue: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if (kind !== 'access' && this.findActiveTurn(scopeId)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
      return;
    }

    if (kind === 'access') {
      await this.handleAccessSettingsCallback(event, rawValue, locale);
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
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'using_server_default_model'));
        return;
      }
      const selected = resolveRequestedModel(models, value);
      if (!selected) {
        await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'model_no_longer_available'));
        return;
      }
      const nextEffort = clampEffortToModel(selected, settings?.reasoningEffort ?? null);
      this.store.setChatSettings(scopeId, selected.model, nextEffort.effort);
      await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'callback_model', { model: selected.model }));
      return;
    }

    if (value === 'default') {
      this.store.setChatSettings(scopeId, settings?.model ?? null, null);
      await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'using_default_effort'));
      return;
    }

    const effort = normalizeRequestedEffort(value);
    if (!effort) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unknown_effort'));
      return;
    }
    const currentModel = resolveCurrentModel(models, settings?.model ?? null);
    if (currentModel && currentModel.supportedReasoningEfforts.length > 0 && !currentModel.supportedReasoningEfforts.includes(effort)) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'effort_not_supported_by_model'));
      return;
    }
    this.store.setChatSettings(scopeId, settings?.model ?? null, effort);
    await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'callback_effort', { effort }));
  }

  private async handleAccessSettingsCallback(event: TelegramCallbackEvent, rawValue: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    const nextPreset = normalizeAccessPreset(rawValue);
    if (!nextPreset) {
      await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    this.store.setChatAccessPreset(scopeId, nextPreset);
    await this.refreshAccessSettingsPanel(scopeId, event.messageId, locale);
    await this.messaging.answerCallback(event.callbackQueryId, t(locale, 'callback_access', {
      value: formatAccessPresetLabel(locale, nextPreset),
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

  private async refreshAccessSettingsPanel(scopeId: string, messageId: number, locale: AppLocale): Promise<void> {
    const access = this.resolveEffectiveAccess(scopeId);
    await this.editHtmlMessage(
      scopeId,
      messageId,
      formatAccessSettingsMessage(locale, access),
      buildAccessSettingsKeyboard(locale, access),
    );
  }

  private async startBoundTurnFromEvent(
    event: TelegramTextEvent,
    locale: AppLocale,
    text: string,
  ): Promise<void> {
    const scopeId = event.scopeId;
    await this.stopWatchingScopeThread(scopeId);
    const existingBinding = this.store.getBinding(scopeId);
    const binding = existingBinding
      ? await this.ensureThreadReady(scopeId, existingBinding)
      : await this.createBinding(scopeId, null);
    await this.sendTyping(scopeId);
    const previewMessageId = 0;
    try {
      const input = await this.buildTurnInput(binding, { ...event, text }, locale);
      const turnState = await this.startTurnWithRecovery(scopeId, binding, input);
      await this.registerActiveTurn(scopeId, event.chatId, event.chatType, event.topicId, turnState.threadId, turnState.turnId, previewMessageId);
    } catch (error) {
      if (previewMessageId > 0) {
        await this.cleanupTransientPreview(scopeId, previewMessageId);
      }
      throw error;
    }
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

  private async cleanupTransientPreview(scopeId: string, messageId: number): Promise<void> {
    try {
      await this.deleteMessage(scopeId, messageId);
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        this.logger.warn('telegram.preview_transient_cleanup_failed', { scopeId, messageId, error: String(error) });
      }
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
    await this.messaging.clearInlineKeyboard(scopeId, messageId);
  }

  private async sendDraft(scopeId: string, draftId: number, text: string): Promise<void> {
    await this.messaging.sendDraft(scopeId, draftId, text);
  }

  private renderActiveStatus(active: ActiveTurn): string {
    const locale = this.localeForChat(active.scopeId);
    return renderActiveTurnStatus(locale, {
      interruptRequested: active.interruptRequested,
      pendingApprovalKinds: active.pendingApprovalKinds,
      toolStatusText: active.toolBatch
        ? formatToolBatchStatus(locale, active.toolBatch.counts, active.toolBatch.actionLines, true)
        : null,
      reasoningActive: active.reasoningActiveCount > 0,
      hasStreamingReply: this.findStreamingSegment(active) !== null,
    });
  }

  private async dismissTurnPreview(active: ActiveTurn): Promise<void> {
    if (!active.previewActive) {
      return;
    }
    await this.cleanupTransientPreview(active.scopeId, active.previewMessageId);
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
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        this.logger.warn('telegram.preview_edit_failed', {
          error: String(error),
          turnId: active.turnId,
          messageId: active.previewMessageId,
        });
      }
      active.previewActive = false;
      active.statusMessageText = null;
      active.statusNeedsRebase = false;
      this.store.removeActiveTurnPreview(active.turnId);
      await this.ensureStatusMessage(active, text);
      return;
    }
    this.clearRenderRetry(active);
  }

  private async rebaseStatusMessage(active: ActiveTurn, text: string): Promise<void> {
    if (active.previewActive) {
      await this.cleanupTransientPreview(active.scopeId, active.previewMessageId);
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
        let messageId: number | null = null;
        if (content.html) {
          messageId = await this.sendHtmlMessage(active.scopeId, content.html);
        } else {
          messageId = await this.sendMessage(active.scopeId, content.text);
        }
        if (active.isObserved && messageId !== null) {
          active.archivedMessageIds.push(messageId);
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
      if (active.isObserved) {
        active.archivedMessageIds.push(active.previewMessageId);
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

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function approvalKeyboard(locale: AppLocale, localId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_allow'), callback_data: `approval:${localId}:accept` },
    { text: t(locale, 'button_allow_session'), callback_data: `approval:${localId}:session` },
    { text: t(locale, 'button_deny'), callback_data: `approval:${localId}:deny` },
  ]];
}

function activeTurnKeyboard(locale: AppLocale, turnId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_interrupt'), callback_data: `turn:interrupt:${turnId}` },
  ]];
}

function whereKeyboard(locale: AppLocale, hasBinding: boolean): Array<Array<{ text: string; callback_data: string }>> {
  const firstRow = [
    { text: t(locale, 'button_permissions'), callback_data: 'nav:permissions' },
    { text: t(locale, 'button_models'), callback_data: 'nav:models' },
  ];
  const secondRow = [{ text: t(locale, 'button_threads'), callback_data: 'nav:threads' }];
  if (!hasBinding) {
    return [firstRow, secondRow];
  }
  return [
    [{ text: t(locale, 'button_reveal'), callback_data: 'nav:reveal' }, { text: t(locale, 'button_permissions'), callback_data: 'nav:permissions' }],
    [{ text: t(locale, 'button_models'), callback_data: 'nav:models' }, { text: t(locale, 'button_threads'), callback_data: 'nav:threads' }],
  ];
}

function renderApprovalMessage(locale: AppLocale, record: PendingApprovalRecord, decision?: ApprovalAction): string {
  const lines = [
    t(locale, 'approval_requested', {
      kind: record.kind === 'fileChange' ? t(locale, 'approval_kind_fileChange') : t(locale, 'approval_kind_command'),
    }),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
  ];
  if (record.command) lines.push(t(locale, 'line_command', { value: record.command }));
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

function mapApprovalDecision(action: ApprovalAction): unknown {
  const decision = action === 'accept'
    ? 'accept'
    : action === 'session'
      ? 'acceptForSession'
      : 'decline';
  return { decision };
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

function isFileMissingError(error: unknown): boolean {
  return error instanceof Error && /enoent|no such file or directory/i.test(error.message);
}

export { BridgeSessionCore as BridgeController };
