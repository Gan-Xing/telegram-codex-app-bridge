import { parseCommand } from './commands.js';
import { isDefaultTelegramScope, resolveTelegramAddressing } from '../telegram/addressing.js';
import type { TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';
import { getTelegramCommands, t } from '../i18n.js';
import type { AppConfig } from '../config.js';
import { resolveEngineCapabilities, type EngineCapabilities } from '../engine/types.js';
import type { BridgeStore } from '../store/database.js';
import type { AppLocale, ThreadBinding } from '../types.js';
import type { TurnRegistry } from './bridge_runtime.js';
import type { AttachmentBatchCoordinator } from './attachment_batch.js';
import type { ApprovalInputCoordinator, ApprovalAction } from './approval_input.js';
import type { GuidedPlanCoordinator, PlanRecoveryAction, PlanSessionAction } from './guided_plan.js';
import type { ThreadPanelCoordinator } from './thread_panel.js';
import type { TurnQueueCoordinator } from './turn_queue.js';
import type { TurnExecutionCoordinator } from './turn_execution.js';
import type { TurnGuidanceCoordinator } from './turn_guidance.js';
import type { SettingsCoordinator } from './settings.js';
import type { ServiceControlCoordinator } from './service_control.js';
import type { ThreadSessionService } from './thread_session.js';
import type { StatusCommandCoordinator } from './status_command.js';
import type { TelegramMessageService } from './telegram_message_service.js';
import { isThreadNotFoundError } from './utils.js';
import { formatModelDisplayName, formatServiceTierLabel } from './presentation.js';

interface TelegramIngressHost {
  config: AppConfig;
  store: BridgeStore;
  turns: TurnRegistry;
  attachmentBatches: AttachmentBatchCoordinator;
  approvalsAndInputs: ApprovalInputCoordinator;
  guidedPlans: GuidedPlanCoordinator;
  threadPanels: ThreadPanelCoordinator;
  queue: TurnQueueCoordinator;
  turnExecution: TurnExecutionCoordinator;
  turnGuidance: TurnGuidanceCoordinator;
  settings: SettingsCoordinator;
  serviceControl: ServiceControlCoordinator;
  sessions: ThreadSessionService;
  statusCommand: StatusCommandCoordinator;
  messages: TelegramMessageService;
  providerCapabilities: EngineCapabilities;
  localeForChat: (scopeId: string, languageCode?: string | null) => AppLocale;
  botUsername: () => string | null;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
}

type CommandHandler = (event: TelegramTextEvent, locale: AppLocale, args: string[]) => Promise<void>;

export class TelegramIngressRouter {
  private readonly commandHandlers: Record<string, CommandHandler>;
  private readonly callbackRoutes: Array<{
    pattern: RegExp;
    handle: (event: TelegramCallbackEvent, match: RegExpExecArray, locale: AppLocale) => Promise<void>;
  }>;

  constructor(private readonly host: TelegramIngressHost) {
    this.commandHandlers = {
      start: (event, locale) => this.showHelp(event.scopeId, locale),
      help: (event, locale) => this.showHelp(event.scopeId, locale),
      status: (event, locale) => this.host.statusCommand.showStatus(event.scopeId, locale),
      where: (event, locale) => this.host.settings.showWherePanel(event.scopeId, undefined, locale),
      threads: (event, locale, args) => this.host.threadPanels.showThreadsPanel(event.scopeId, undefined, args.join(' ').trim() || null, locale),
      open: (event, locale, args) => this.handleOpenCommand(event.scopeId, locale, args),
      new: (event, locale, args) => this.handleNewCommand(event.scopeId, locale, args),
      model: (event, locale, args) => this.host.settings.handleModelCommand(event, locale, args),
      models: (event, locale) => this.host.settings.showModelSettingsPanel(event.scopeId, undefined, locale),
      tier: (event, locale, args) => this.host.settings.handleTierCommand(event, locale, args),
      fast: (event, locale, args) => this.host.settings.handleFastCommand(event, locale, args),
      mode: (event, locale, args) => this.host.settings.handleModeCommand(event, locale, args),
      settings: (event, locale) => this.host.settings.showSettingsHomePanel(event.scopeId, undefined, locale),
      reconnect: (event, locale) => this.host.serviceControl.reconnect(event.scopeId, locale),
      restart: (event, locale) => this.host.serviceControl.restart(event.scopeId, locale),
      queue: (event, locale, args) => this.host.queue.handleQueueCommand(event, locale, args),
      guide: (event, locale, args) => this.host.turnGuidance.handleGuideCommand(event, locale, args),
      permissions: (event, locale) => this.host.settings.showAccessSettingsPanel(event.scopeId, undefined, locale),
      access: (event, locale) => this.host.settings.showAccessSettingsPanel(event.scopeId, undefined, locale),
      plan: (event, locale, args) => this.host.settings.handlePlanAliasCommand(event, locale, args),
      effort: (event, locale, args) => this.host.settings.handleEffortCommand(event, locale, args),
      reveal: (event, locale) => this.handleRevealCommand(event.scopeId, locale),
      focus: (event, locale) => this.handleRevealCommand(event.scopeId, locale),
      interrupt: (event, locale) => this.host.turnExecution.handleInterruptCommand(event.scopeId, locale).then(() => undefined),
    };
    this.callbackRoutes = [
      {
        pattern: /^turn:interrupt:(.+)$/,
        handle: (event, match, locale) => this.host.turnExecution.handleTurnInterruptCallback(event, match[1]!, locale),
      },
      {
        pattern: /^thread:open:(.+)$/,
        handle: (event, match, locale) => this.host.threadPanels.handleThreadOpenCallback(event, match[1]!, locale),
      },
      {
        pattern: /^thread:rename:(start|confirm|cancel):(.+)$/,
        handle: (event, match, locale) => this.host.threadPanels.handleThreadRenameCallback(
          event,
          match[1]! as 'start' | 'confirm' | 'cancel',
          match[2]!,
          locale,
        ),
      },
      {
        pattern: /^thread:list:(prev|next|clear)$/,
        handle: (event, match, locale) => this.host.threadPanels.handleThreadListNavigationCallback(
          event,
          match[1]! as 'prev' | 'next' | 'clear',
          locale,
        ),
      },
      {
        pattern: /^nav:(models|mode|threads|reveal|permissions)$/,
        handle: (event, match, locale) => this.host.settings.handleNavigationCallback(
          event,
          match[1]! as 'models' | 'mode' | 'threads' | 'reveal' | 'permissions',
          locale,
        ),
      },
      {
        pattern: /^settings:(plan-gate|queue|history):(on|off)$/,
        handle: (event, match, locale) => this.host.settings.handleGuidedPlanSettingsCallback(
          event,
          match[1]! as 'plan-gate' | 'queue' | 'history',
          match[2]! as 'on' | 'off',
          locale,
        ),
      },
      {
        pattern: /^settings:(model|effort|variant|tier|mode|access):(.+)$/,
        handle: (event, match, locale) => this.host.settings.handleSettingsCallback(
          event,
          match[1]! as 'model' | 'effort' | 'variant' | 'tier' | 'mode' | 'access',
          match[2]!,
          locale,
        ),
      },
      {
        pattern: /^plan:([a-f0-9]+):(confirm|revise|cancel)$/,
        handle: (event, match, locale) => this.host.guidedPlans.handlePlanSessionCallback(
          event,
          match[1]!,
          match[2]! as PlanSessionAction,
          locale,
        ),
      },
      {
        pattern: /^recover:([a-f0-9]+):(continue|show|cancel)$/,
        handle: (event, match, locale) => this.host.guidedPlans.handlePlanRecoveryCallback(
          event,
          match[1]!,
          match[2]! as PlanRecoveryAction,
          locale,
        ),
      },
      {
        pattern: /^guidance:([a-f0-9]+):(steer|keep)$/,
        handle: (event, match, locale) => this.host.turnGuidance.handleQueuedGuidanceCallback(
          event,
          match[1]!,
          match[2]! as 'steer' | 'keep',
          locale,
        ),
      },
      {
        pattern: /^queue:(next|clear)$/,
        handle: (event, match, locale) => this.host.queue.handleQueueCallback(event, match[1]! as 'next' | 'clear', locale),
      },
      {
        pattern: /^attach:([a-f0-9]+):(next|analyze|clear)$/,
        handle: (event, match, locale) => this.host.attachmentBatches.handleAttachmentBatchCallback(
          event,
          match[1]!,
          match[2]! as 'next' | 'analyze' | 'clear',
          locale,
        ).then(() => undefined),
      },
      {
        pattern: /^input:([a-f0-9]+):(other|back|cancel|submit|edit:\d+|option:\d+)$/,
        handle: (event, match, locale) => this.host.approvalsAndInputs.handlePendingUserInputCallback(event, match[1]!, match[2]!, locale).then(() => undefined),
      },
      {
        pattern: /^approval:([a-f0-9]+):(accept|session|deny|details|back)$/,
        handle: (event, match, locale) => this.host.approvalsAndInputs.handleApprovalCallback(
          event,
          match[1]!,
          match[2]! as ApprovalAction | 'details' | 'back',
          locale,
        ).then(() => undefined),
      },
    ];
  }

  async handleText(event: TelegramTextEvent): Promise<void> {
    const scopeId = event.scopeId;
    const locale = this.host.localeForChat(scopeId, event.languageCode);
    this.host.store.insertAudit('inbound', scopeId, 'telegram.message', event.text);
    const command = event.attachments.length === 0 ? parseCommand(event.text) : null;
    const decision = resolveTelegramAddressing({
      text: event.text,
      attachmentsCount: event.attachments.length,
      entities: event.entities,
      command,
      botUsername: this.host.botUsername(),
      isDefaultTopic: isDefaultTelegramScope({
        chatType: event.chatType,
        allowedChatId: this.host.config.tgAllowedChatId,
        allowedTopicId: this.host.config.tgAllowedTopicId,
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
    if (await this.host.approvalsAndInputs.handlePendingUserInputText(scopeId, decision.text, locale)) {
      return;
    }
    if (await this.host.threadPanels.handleThreadRenameText(scopeId, decision.text, locale)) {
      return;
    }
    if (event.attachments.length > 0) {
      const existingBinding = this.host.store.getBinding(scopeId);
      const binding = existingBinding
        ? await this.host.sessions.ensureThreadReady(scopeId, existingBinding)
        : await this.host.sessions.createBinding(scopeId, null);
      await this.host.messages.sendTyping(scopeId);
      await this.host.attachmentBatches.handleInboundAttachmentMessage(event, binding, decision.text, locale);
      return;
    }
    const awaitingPlanConfirmation = this.host.guidedPlans.getAwaitingPlanConfirmationSession(scopeId);
    if (awaitingPlanConfirmation) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'plan_confirmation_pending'));
      return;
    }
    const recoveryRequiredSession = this.host.store.listOpenPlanSessions(scopeId)
      .find((session) => session.state === 'recovery_required') ?? null;
    if (recoveryRequiredSession) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'plan_recovery_pending'));
      return;
    }
    if (await this.host.attachmentBatches.handleTextWithPendingBatch({ ...event, text: decision.text }, decision.text, locale)) {
      return;
    }
    const activeTurn = this.host.turns.findByScope(scopeId);
    if (activeTurn) {
      const settings = this.host.store.getChatSettings(scopeId);
      if (!(settings?.autoQueueMessages ?? true)) {
        await this.host.messages.sendMessage(scopeId, t(locale, 'another_turn_running'));
        return;
      }
      await this.host.messages.sendTyping(scopeId);
      const queuedRecord = await this.host.queue.enqueueTurnInput(
        this.host.sessions.resolveActiveTurnBinding(scopeId, activeTurn),
        { ...event, text: decision.text },
        locale,
      );
      await this.host.turnGuidance.maybeOfferQueuedGuidancePrompt(queuedRecord, activeTurn.turnId, locale);
      return;
    }

    const existingBinding = this.host.store.getBinding(scopeId);
    const binding = existingBinding
      ? await this.host.sessions.ensureThreadReady(scopeId, existingBinding)
      : await this.host.sessions.createBinding(scopeId, null);
    await this.host.messages.sendTyping(scopeId);
    const input = await this.host.sessions.buildTurnInput(binding, { ...event, text: decision.text }, locale);
    await this.host.turnExecution.startIncomingTurn(scopeId, event.chatId, event.chatType, event.topicId, binding, input);
  }

  async handleCommand(event: TelegramTextEvent, locale: AppLocale, name: string, args: string[]): Promise<void> {
    const handler = this.commandHandlers[name];
    if (!handler) {
      await this.host.messages.sendMessage(event.scopeId, t(locale, 'unknown_command', { name }));
      return;
    }
    if (!this.isCommandSupported(name)) {
      await this.host.messages.sendMessage(event.scopeId, t(locale, 'command_not_supported', { name }));
      return;
    }
    await handler(event, locale, args);
  }

  async handleCallback(event: TelegramCallbackEvent): Promise<void> {
    const locale = this.host.localeForChat(event.scopeId, event.languageCode);
    if (event.data === 'settings:home') {
      await this.host.settings.showSettingsHomePanel(event.scopeId, event.messageId, locale);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'opened_settings_home'));
      return;
    }
    for (const route of this.callbackRoutes) {
      const match = route.pattern.exec(event.data);
      if (!match) {
        continue;
      }
      await route.handle(event, match, locale);
      return;
    }
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
  }

  private async showHelp(scopeId: string, locale: AppLocale): Promise<void> {
    const commands = getTelegramCommands(locale, this.host.config.bridgeEngine, { restart: this.supportsRestartCommand() })
      .map((entry) => `/${entry.command}`);
    const trailer = [
      ...(this.host.config.bridgeEngine === 'codex' ? [t(locale, 'help_advanced_aliases')] : []),
      t(locale, 'help_plain_text_hint'),
    ];
    await this.host.messages.sendMessage(scopeId, [
      t(locale, 'help_commands_title'),
      ...commands,
      ...trailer,
    ].join('\n'));
  }

  private async handleOpenCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const target = Number.parseInt(args[0] || '', 10);
    if (!Number.isFinite(target)) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'usage_open'));
      return;
    }
    const thread = this.host.store.getCachedThread(scopeId, target);
    if (!thread) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'unknown_cached_thread'));
      return;
    }
    let binding: ThreadBinding;
    try {
      binding = await this.host.sessions.bindCachedThread(scopeId, thread.threadId);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        await this.host.messages.sendMessage(scopeId, t(locale, 'cached_thread_unavailable'));
        return;
      }
      throw error;
    }
    const settings = this.host.store.getChatSettings(scopeId);
    const lines = [
      t(locale, 'bound_to_thread', { threadId: binding.threadId }),
      t(locale, 'line_title', { value: thread.name || thread.preview || t(locale, 'empty') }),
      t(locale, 'status_configured_model', { value: formatModelDisplayName(settings?.model) ?? t(locale, 'server_default') }),
      t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
      t(locale, 'status_configured_service_tier', { value: formatServiceTierLabel(locale, settings?.serviceTier ?? null) }),
      t(locale, 'line_cwd', { value: binding.cwd ?? this.host.config.defaultCwd }),
    ];
    if (this.host.config.codexAppSyncOnOpen) {
      const revealError = await this.host.sessions.tryRevealThread(scopeId, binding.threadId, 'open');
      lines.push(revealError ? t(locale, 'codex_sync_failed', { error: revealError }) : t(locale, 'opened_in_codex'));
    }
    await this.host.messages.sendMessage(scopeId, lines.join('\n'));
    await this.host.threadPanels.renderThreadHistoryPreview(scopeId, binding.threadId, locale);
  }

  private async handleNewCommand(scopeId: string, locale: AppLocale, args: string[]): Promise<void> {
    const cwd = args.join(' ').trim() || this.host.config.defaultCwd;
    const binding = await this.host.sessions.createBinding(scopeId, cwd);
    const settings = this.host.store.getChatSettings(scopeId);
    await this.host.messages.sendMessage(scopeId, [
      t(locale, 'started_new_thread', { threadId: binding.threadId }),
      t(locale, 'line_cwd', { value: binding.cwd ?? cwd }),
      t(locale, 'status_configured_model', { value: formatModelDisplayName(settings?.model) ?? t(locale, 'server_default') }),
      t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
      t(locale, 'status_configured_service_tier', { value: formatServiceTierLabel(locale, settings?.serviceTier ?? null) }),
    ].join('\n'));
  }

  private async handleRevealCommand(scopeId: string, locale: AppLocale): Promise<void> {
    if (this.host.config.bridgeEngine !== 'codex') {
      await this.host.messages.sendMessage(scopeId, t(locale, 'reveal_not_supported'));
      return;
    }
    const binding = this.host.store.getBinding(scopeId);
    if (!binding) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'no_thread_bound_reveal'));
      return;
    }
    const readyBinding = await this.host.sessions.ensureThreadReady(scopeId, binding);
    const revealError = await this.host.sessions.tryRevealThread(scopeId, readyBinding.threadId, 'reveal');
    if (revealError) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'failed_open_codex', { error: revealError }));
      return;
    }
    await this.host.messages.sendMessage(scopeId, t(locale, 'opened_thread_in_codex', { threadId: readyBinding.threadId }));
  }

  private isCommandSupported(name: string): boolean {
    const capabilities = resolveEngineCapabilities(this.host.providerCapabilities);
    switch (name) {
      case 'threads':
      case 'open':
        return capabilities.threads;
      case 'guide':
        return capabilities.steerActiveTurn;
      case 'reveal':
      case 'focus':
        return capabilities.reveal;
      case 'reconnect':
        return capabilities.reconnect;
      case 'restart':
        return this.supportsRestartCommand();
      case 'mode':
        return this.host.config.bridgeEngine === 'gemini' || capabilities.guidedPlan === 'full';
      case 'plan':
        return capabilities.guidedPlan === 'full';
      case 'permissions':
      case 'access':
        return capabilities.approvals !== 'none';
      case 'tier':
      case 'fast':
        return capabilities.serviceTier;
      case 'effort':
        return capabilities.reasoningEffort;
      default:
        return true;
    }
  }

  private supportsRestartCommand(): boolean {
    return (this.host.config.platform?.restartMode ?? 'service') !== 'none';
  }
}
