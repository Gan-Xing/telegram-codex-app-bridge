import type { AppConfig } from '../config.js';
import { normalizeLocale, t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { EngineProvider } from '../engine/types.js';
import type { TelegramGateway } from '../telegram/gateway.js';
import type { AppLocale } from '../types.js';
import { AttachmentBatchCoordinator } from './attachment_batch.js';
import { ApprovalInputCoordinator } from './approval_input.js';
import { BridgeRuntime, RuntimeStatusStore, ThreadAttachmentRegistry, ScopeLockRegistry, TurnRegistry, notifyAsyncError } from './bridge_runtime.js';
import { CodexIngressRouter } from './codex_ingress.js';
import { GuidedPlanCoordinator } from './guided_plan.js';
import { SettingsCoordinator } from './settings.js';
import { ServiceControlCoordinator } from './service_control.js';
import { StatusCommandCoordinator } from './status_command.js';
import { StatusPreviewCoordinator } from './status_preview.js';
import { TelegramIngressRouter } from './telegram_ingress.js';
import { TelegramMessageService } from './telegram_message_service.js';
import { ThreadPanelCoordinator } from './thread_panel.js';
import { ThreadSessionService } from './thread_session.js';
import { TurnExecutionCoordinator } from './turn_execution.js';
import { TurnGuidanceCoordinator } from './turn_guidance.js';
import { TurnLifecycleCoordinator } from './turn_lifecycle.js';
import { TurnQueueCoordinator } from './turn_queue.js';
import { TurnRenderingCoordinator } from './turn_rendering.js';
import { inferTelegramChatType } from './utils.js';
import type { ActiveTurn } from './turn_state.js';

export interface BridgeComposition {
  runtime: BridgeRuntime;
  locks: ScopeLockRegistry;
  messages: TelegramMessageService;
  runtimeStatus: RuntimeStatusStore;
  activeTurns: TurnRegistry;
  attachedThreads: ThreadAttachmentRegistry;
  attachmentBatches: AttachmentBatchCoordinator;
  threadPanels: ThreadPanelCoordinator;
  approvalsAndInputs: ApprovalInputCoordinator;
  guidedPlans: GuidedPlanCoordinator;
  turnRendering: TurnRenderingCoordinator;
  statusPreview: StatusPreviewCoordinator;
  turnLifecycle: TurnLifecycleCoordinator;
  sessions: ThreadSessionService;
  settings: SettingsCoordinator;
  serviceControl: ServiceControlCoordinator;
  statusCommand: StatusCommandCoordinator;
  turnExecution: TurnExecutionCoordinator;
  turnGuidance: TurnGuidanceCoordinator;
  turnQueue: TurnQueueCoordinator;
  telegramRouter: TelegramIngressRouter;
  codexRouter: CodexIngressRouter;
  localeForChat: (scopeId: string, languageCode?: string | null) => AppLocale;
  updateStatus: () => void;
  handleAsyncError: (source: string, error: unknown, scopeId?: string) => Promise<void>;
  syncGuidedPlanQueueDepth: (scopeId: string, queueDepth?: number) => Promise<void>;
}

export function createBridgeComposition(
  config: AppConfig,
  store: BridgeStore,
  logger: Logger,
  bot: TelegramGateway,
  app: EngineProvider,
): BridgeComposition {
  const runtime = new BridgeRuntime();
  const locks = new ScopeLockRegistry();
  const activeTurns = runtime.turns;
  const attachedThreads = runtime.attachedThreads;
  const messages = new TelegramMessageService(bot, {
    audit: (direction, scopeId, eventType, summary) => {
      store.insertAudit(direction, scopeId, eventType, summary);
    },
  });
  const runtimeStatus = new RuntimeStatusStore(config, store, app, activeTurns);

  const localeForChat = (scopeId: string, languageCode?: string | null): AppLocale => {
    if (languageCode) {
      const locale = normalizeLocale(languageCode);
      const current = store.getChatSettings(scopeId);
      if (current?.locale !== locale) {
        store.setChatLocale(scopeId, locale);
      }
      return locale;
    }
    return store.getChatSettings(scopeId)?.locale ?? 'en';
  };

  const updateStatus = (): void => {
    runtimeStatus.publish();
  };

  const handleAsyncError = async (source: string, error: unknown, scopeId?: string): Promise<void> => {
    await notifyAsyncError(
      logger,
      runtimeStatus,
      async (chatScopeId, formattedError) => {
        await messages.sendMessage(chatScopeId, t(localeForChat(chatScopeId), 'bridge_error', { error: formattedError }));
      },
      source,
      error,
      scopeId,
    );
  };

  const syncGuidedPlanQueueDepth = async (scopeId: string, queueDepth = store.countQueuedTurnInputs(scopeId)): Promise<void> => {
    await refs.guidedPlans.syncQueueDepth(scopeId, queueDepth);
  };

  const sessions = new ThreadSessionService({
    config,
    store,
    logger,
    app,
    bot,
    attachedThreads,
    localeForChat,
    sendMessage: (scopeId, text) => messages.sendMessage(scopeId, text),
    updateStatus,
  });

  const threadPanels = new ThreadPanelCoordinator({
    config: {
      threadListLimit: config.threadListLimit,
      codexAppSyncOnOpen: config.codexAppSyncOnOpen,
      allowThreadArchive: config.bridgeEngine === 'codex',
    },
    store,
    logger,
    app,
    bindCachedThread: (scopeId, threadId) => sessions.bindCachedThread(scopeId, threadId),
    tryRevealThread: (scopeId, threadId, source) => sessions.tryRevealThread(scopeId, threadId, source),
    clearBinding: (scopeId) => store.clearBinding(scopeId),
    getActiveTurnThreadId: (scopeId) => activeTurns.findByScope(scopeId)?.threadId ?? null,
    sendMessage: (scopeId, text, inlineKeyboard) => messages.sendMessage(scopeId, text, inlineKeyboard),
    sendHtmlMessage: (scopeId, text, inlineKeyboard) => messages.sendHtmlMessage(scopeId, text, inlineKeyboard),
    editMessage: (scopeId, messageId, text, inlineKeyboard) => messages.editMessage(scopeId, messageId, text, inlineKeyboard),
    editHtmlMessage: (scopeId, messageId, text, inlineKeyboard) => messages.editHtmlMessage(scopeId, messageId, text, inlineKeyboard),
    answerCallback: (callbackQueryId, text) => bot.answerCallback(callbackQueryId, text),
  });

  const refs = {} as {
    turnRendering: TurnRenderingCoordinator;
    settings: SettingsCoordinator;
    turnExecution: TurnExecutionCoordinator;
    turnGuidance: TurnGuidanceCoordinator;
    guidedPlans: GuidedPlanCoordinator;
    turnQueue: TurnQueueCoordinator;
  };
  const statusPreview = new StatusPreviewCoordinator({
    logger,
    store,
    messages,
    localeForChat: (scopeId) => localeForChat(scopeId),
    renderActiveStatus: (active) => refs.turnRendering.renderActiveStatus(active),
    scheduleRenderRetry: (active, delayMs) => refs.turnRendering.scheduleRenderRetry(active, delayMs),
    clearRenderRetry: (active) => refs.turnRendering.clearRenderRetry(active),
  });

  const approvalsAndInputs = new ApprovalInputCoordinator({
    store,
    logger,
    app,
    resolveChatByThread: (threadId) => activeTurns.findByThreadId(threadId)?.scopeId ?? store.findChatIdByThreadId(threadId),
    localeForChat: (scopeId) => localeForChat(scopeId),
    shouldAllowInteractiveUserInput: (scopeId) => refs.settings.shouldAllowInteractiveUserInput(scopeId),
    notePendingApprovalStatus: (threadId, kind) => refs.turnExecution.notePendingApprovalStatus(threadId, kind),
    clearPendingApprovalStatus: (threadId, kind) => refs.turnExecution.clearPendingApprovalStatus(threadId, kind),
    notePendingUserInputStatus: (threadId, localId) => refs.turnExecution.notePendingUserInputStatus(threadId, localId),
    clearPendingUserInputStatus: (threadId, localId) => refs.turnExecution.clearPendingUserInputStatus(threadId, localId),
    sendMessage: (scopeId, text, inlineKeyboard) => messages.sendMessage(scopeId, text, inlineKeyboard),
    sendHtmlMessage: (scopeId, text, inlineKeyboard) => messages.sendHtmlMessage(scopeId, text, inlineKeyboard),
    editMessage: (scopeId, messageId, text, inlineKeyboard) => messages.editMessage(scopeId, messageId, text, inlineKeyboard),
    editHtmlMessage: (scopeId, messageId, text, inlineKeyboard) => messages.editHtmlMessage(scopeId, messageId, text, inlineKeyboard),
    answerCallback: (callbackQueryId, text) => bot.answerCallback(callbackQueryId, text),
    updateStatus,
  });

  refs.settings = new SettingsCoordinator({
    config,
    store,
    app,
    messages,
    threadPanels,
    sessions,
    turns: activeTurns,
    localeForChat: (scopeId) => localeForChat(scopeId),
    clearPendingUserInputsIfNeeded: async (scopeId, locale = localeForChat(scopeId)) => {
      if (refs.settings.shouldAllowInteractiveUserInput(scopeId)) {
        return;
      }
      await approvalsAndInputs.clearPendingUserInputsIfNeeded(scopeId, locale);
    },
    answerCallback: (callbackQueryId, text) => bot.answerCallback(callbackQueryId, text),
  });

  refs.turnRendering = new TurnRenderingCoordinator({
    logger,
    config: {
      telegramPreviewThrottleMs: config.telegramPreviewThrottleMs,
    },
    localeForChat: (scopeId) => localeForChat(scopeId),
    countQueuedTurns: (scopeId) => store.countQueuedTurnInputs(scopeId),
    sendMessage: (scopeId, text, inlineKeyboard) => messages.sendMessage(scopeId, text, inlineKeyboard),
    editMessage: (scopeId, messageId, text, inlineKeyboard) => messages.editMessage(scopeId, messageId, text, inlineKeyboard),
    deleteMessage: (scopeId, messageId) => messages.deleteMessage(scopeId, messageId),
    sendDraft: (scopeId, draftId, text) => messages.sendDraft(scopeId, draftId, text),
    syncTurnStatus: (active, force) => statusPreview.syncTurnStatus(active as ActiveTurn, force),
    scheduleRenderRetry: (active, delayMs) => refs.turnRendering.scheduleRenderRetry(active as ActiveTurn, delayMs),
    isTurnActive: (turnId) => activeTurns.has(turnId),
  });

  const turnLifecycle = new TurnLifecycleCoordinator({
    logger,
    codexAppSyncOnTurnComplete: config.codexAppSyncOnTurnComplete,
    localeForChat: (scopeId) => localeForChat(scopeId),
    setActiveTurn: (turnId, active) => activeTurns.set(turnId, active as ActiveTurn),
    deleteActiveTurn: (turnId) => activeTurns.delete(turnId),
    listActiveTurns: () => activeTurns.list(),
    savePreviewRecord: (turnId, scopeId, threadId, messageId) => store.saveActiveTurnPreview({ turnId, scopeId, threadId, messageId }),
    listStoredPreviews: () => store.listActiveTurnPreviews(),
    queueRender: (active, options) => refs.turnRendering.queueRender(active as ActiveTurn, options),
    clearRenderRetry: (active) => refs.turnRendering.clearRenderRetry(active as ActiveTurn),
    clearToolBatchTimer: (batch) => refs.turnRendering.clearToolBatchTimer(batch),
    cleanupFinishedPreview: (active, locale) => statusPreview.cleanupFinishedPreview(active as any, locale),
    retirePreviewMessage: (scopeId, messageId, text, turnId) => statusPreview.retirePreviewMessage(scopeId, messageId, text, turnId),
    sendMessage: (scopeId, text) => messages.sendMessage(scopeId, text),
    renderPlanCard: (active) => refs.guidedPlans.renderPlanCard(active),
    finalizeGuidedPlanTurn: (active) => refs.guidedPlans.finalizeTurn(active),
    markQueuedTurnCompleted: (queueId) => store.updateQueuedTurnInputStatus(queueId, 'completed'),
    syncGuidedPlanQueueDepth,
    tryRevealThread: (scopeId, threadId, reason) => sessions.tryRevealThread(scopeId, threadId, reason),
    updateStatus,
    autostartQueuedTurn: (scopeId) => locks.withLock(scopeId, async () => {
      await refs.turnQueue.maybeStartQueuedTurn(scopeId);
    }),
    handleAsyncError,
  });

  refs.turnExecution = new TurnExecutionCoordinator({
    logger,
    store,
    app,
    turns: activeTurns,
    localeForChat: (scopeId) => localeForChat(scopeId),
    shouldRequirePlanConfirmation: (scopeId) => refs.settings.shouldRequirePlanConfirmation(scopeId),
    messages,
      answerCallback: (callbackQueryId, text) => bot.answerCallback(callbackQueryId, text),
      handleAsyncError,
      guidedPlans: {
      createSession: (scopeId, threadId, turnId) => refs.guidedPlans.createSession(scopeId, threadId, turnId),
      syncTurnPlan: (active, params) => refs.guidedPlans.syncTurnPlan(active, params),
      queuePlanRender: (active) => refs.guidedPlans.queuePlanRender(active),
    },
    turnRendering: refs.turnRendering,
    turnLifecycle,
    statusPreview,
    startTurnWithRecovery: (scopeId, binding, input, options) => sessions.startTurnWithRecovery(scopeId, binding, input, options),
    noteTurnFailure: (message) => {
      runtimeStatus.setSerializedLastError(message);
      updateStatus();
    },
    onStatusChanged: updateStatus,
  });

  refs.turnGuidance = new TurnGuidanceCoordinator({
    logger,
    store,
    turns: activeTurns,
    app,
    messages,
    localeForChat: (scopeId) => localeForChat(scopeId),
    answerCallback: (callbackQueryId, text) => bot.answerCallback(callbackQueryId, text),
    syncGuidedPlanQueueDepth,
    updateStatus,
    buildTurnInput: (binding, event, locale) => sessions.buildTurnInput(binding, event, locale),
    resolveActiveTurnBinding: (scopeId, active) => sessions.resolveActiveTurnBinding(scopeId, active),
  });

  refs.guidedPlans = new GuidedPlanCoordinator({
    store,
    logger,
    localeForChat: (scopeId) => localeForChat(scopeId),
    sendMessage: (scopeId, text, inlineKeyboard) => messages.sendMessage(scopeId, text, inlineKeyboard),
    sendHtmlMessage: (scopeId, text, inlineKeyboard) => messages.sendHtmlMessage(scopeId, text, inlineKeyboard),
    editHtmlMessage: (scopeId, messageId, text, inlineKeyboard) => messages.editHtmlMessage(scopeId, messageId, text, inlineKeyboard),
    answerCallback: (callbackQueryId, text) => bot.answerCallback(callbackQueryId, text),
    sendTyping: (scopeId) => messages.sendTyping(scopeId),
      updateStatus,
      hasActiveTurnInScope: (scopeId) => Boolean(activeTurns.findByScope(scopeId)),
      hasActiveTurn: (turnId) => activeTurns.has(turnId),
      refreshActiveTurnStatus: async (scopeId) => {
        const active = activeTurns.findByScope(scopeId);
        if (active) {
        await refs.turnRendering.queueRender(active, { forceStatus: true });
        }
      },
      resolvePlanSessionBinding: (scopeId, threadId) => sessions.resolvePlanSessionBinding(scopeId, threadId),
      startTurnWithRecovery: (scopeId, binding, input, options) => sessions.startTurnWithRecovery(scopeId, binding, input, options),
      launchRegisteredTurn: (scopeId, chatId, topicId, threadId, turnId, options) => {
      refs.turnExecution.launchRegisteredTurn(
        scopeId,
        chatId,
        inferTelegramChatType(chatId),
        topicId,
        threadId,
        turnId,
        0,
        options,
      );
    },
    maybeStartQueuedTurn: (scopeId) => refs.turnQueue.maybeStartQueuedTurn(scopeId),
  });

  refs.turnQueue = new TurnQueueCoordinator({
    store,
    logger,
    turns: activeTurns,
    messages,
    localeForChat: (scopeId) => localeForChat(scopeId),
    updateStatus,
    syncGuidedPlanQueueDepth,
    buildTurnInput: (binding, event, locale) => sessions.buildTurnInput(binding, event, locale),
    ensureThreadReady: (scopeId, binding) => sessions.ensureThreadReady(scopeId, binding),
    launchTurn: (scopeId, chatId, chatType, topicId, binding, input, options) =>
      refs.turnExecution.startIncomingTurn(scopeId, chatId, chatType, topicId, binding, input, options),
    answerCallback: (callbackQueryId, text) => bot.answerCallback(callbackQueryId, text),
    dismissQueuedGuidancePrompt: (queueId) => refs.turnGuidance.dismissQueuedGuidancePrompt(queueId),
  });

  const attachmentBatches = new AttachmentBatchCoordinator({
    store,
    logger,
    turns: activeTurns,
    messages,
    localeForChat: (scopeId) => localeForChat(scopeId),
    stageInboundAttachments: (binding, attachments, locale) => sessions.stageInboundAttachments(binding, attachments, locale),
    buildTurnInputFromStagedAttachments: (text, attachments) => sessions.buildTurnInputFromStagedAttachments(text, attachments),
    ensureBinding: async (scopeId) => {
      const existing = store.getBinding(scopeId);
      return existing
        ? sessions.ensureThreadReady(scopeId, existing)
        : sessions.createBinding(scopeId, null);
    },
    enqueuePreparedTurnInput: (params, locale) => refs.turnQueue.enqueuePreparedTurnInput(params, locale),
    startIncomingTurn: (scopeId, chatId, chatType, topicId, binding, input) =>
      refs.turnExecution.startIncomingTurn(scopeId, chatId, chatType, topicId, binding, input),
    answerCallback: (callbackQueryId, text) => bot.answerCallback(callbackQueryId, text),
    updateStatus,
  });

  const statusCommand = new StatusCommandCoordinator({
    store,
    logger,
    app,
    messages,
    activeTurnCount: () => activeTurns.count(),
    localeForChat: (scopeId) => localeForChat(scopeId),
    resolveEffectiveAccess: (scopeId) => refs.settings.resolveEffectiveAccess(scopeId),
    lastError: () => runtimeStatus.getLastError(),
    updateStatus,
    config: {
      bridgeEngine: config.bridgeEngine,
      bridgeInstanceId: config.bridgeInstanceId,
      codexDefaultProviderProfileId: config.codexDefaultProviderProfileId,
      codexProviderProfiles: config.codexProviderProfiles,
      codexAppSyncOnOpen: config.codexAppSyncOnOpen,
      codexAppSyncOnTurnComplete: config.codexAppSyncOnTurnComplete,
    },
  });

  const serviceControl = new ServiceControlCoordinator({
    logger,
    restartMode: config.platform?.restartMode ?? 'service',
    app,
    messages,
    localeForChat: (scopeId) => localeForChat(scopeId),
    activeTurnCount: () => activeTurns.count(),
    runtimeStatus,
    updateStatus,
    restartBridge: async () => {
      bot.stop();
      await app.stop();
      updateStatus();
      let startError: unknown = null;
      try {
        await app.start();
      } catch (error) {
        startError = error;
      }
      await bot.start();
      runtimeStatus.setBotUsername(bot.username);
      updateStatus();
      if (startError) {
        throw startError;
      }
    },
  });

  const telegramRouter = new TelegramIngressRouter({
    config,
    store,
    turns: activeTurns,
    approvalsAndInputs,
    guidedPlans: refs.guidedPlans,
    attachmentBatches,
    threadPanels,
    queue: refs.turnQueue,
    turnExecution: refs.turnExecution,
    turnGuidance: refs.turnGuidance,
    settings: refs.settings,
    serviceControl,
    sessions,
    statusCommand,
    messages,
    providerCapabilities: app.capabilities,
    localeForChat,
    botUsername: () => runtimeStatus.getBotUsername(),
    answerCallback: (callbackQueryId, text) => bot.answerCallback(callbackQueryId, text),
  });

  const codexRouter = new CodexIngressRouter({
    logger,
    store,
    app,
    turns: activeTurns,
    approvalsAndInputs,
    guidedPlans: refs.guidedPlans,
    turnExecution: refs.turnExecution,
    turnLifecycle,
    settings: refs.settings,
    sessions,
    messages,
    localeForChat: (scopeId) => localeForChat(scopeId),
    runtimeStatus,
    updateStatus,
  });

  return {
    runtime,
    locks,
    messages,
    runtimeStatus,
    activeTurns,
    attachedThreads,
    threadPanels,
    attachmentBatches,
    approvalsAndInputs,
    guidedPlans: refs.guidedPlans,
    turnRendering: refs.turnRendering,
    statusPreview,
    turnLifecycle,
    sessions,
    settings: refs.settings,
    serviceControl,
    statusCommand,
    turnExecution: refs.turnExecution,
    turnGuidance: refs.turnGuidance,
    turnQueue: refs.turnQueue,
    telegramRouter,
    codexRouter,
    localeForChat,
    updateStatus,
    handleAsyncError,
    syncGuidedPlanQueueDepth,
  };
}
