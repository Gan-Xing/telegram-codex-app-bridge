import type { AppConfig } from '../config.js';
import type { CodexAppClient } from '../codex_app/client.js';
import { t } from '../i18n.js';
import type { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';
import type { AppLocale, ModelInfo, ServiceTierValue } from '../types.js';
import { normalizeAccessPreset, resolveAccessMode, type ResolvedAccessMode } from './access.js';
import {
  buildAccessSettingsKeyboard,
  buildSettingsHomeKeyboard,
  buildModeSettingsKeyboard,
  buildModelSettingsKeyboard,
  clampEffortToModel,
  formatAccessPresetLabel,
  formatAccessSettingsMessage,
  formatApprovalPolicyLabel,
  formatCollaborationModeLabel,
  formatModeSettingsMessage,
  formatModelSettingsMessage,
  formatServiceTierLabel,
  formatSettingsHomeMessage,
  formatSandboxModeLabel,
  formatTelegramScopeLabel,
  formatWhereMessage,
  normalizeRequestedEffort,
  normalizeRequestedServiceTier,
  resolveCurrentModel,
  resolveRequestedModel,
} from './presentation.js';
import type { ThreadPanelCoordinator } from './thread_panel.js';
import type { TelegramMessageService } from './telegram_message_service.js';
import type { ThreadSessionService } from './thread_session.js';
import type { TurnRegistry } from './bridge_runtime.js';
import { normalizeRequestedCollaborationMode } from './utils.js';

interface SettingsHost {
  config: AppConfig;
  store: BridgeStore;
  app: Pick<CodexAppClient, 'listModels' | 'readThread'>;
  messages: TelegramMessageService;
  threadPanels: Pick<ThreadPanelCoordinator, 'showThreadsPanel'>;
  sessions: Pick<ThreadSessionService, 'ensureThreadReady' | 'tryRevealThread'>;
  turns: TurnRegistry;
  localeForChat: (scopeId: string) => AppLocale;
  clearPendingUserInputsIfNeeded: (scopeId: string, locale?: AppLocale) => Promise<void>;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
}

export class SettingsCoordinator {
  constructor(private readonly host: SettingsHost) {}

  resolveEffectiveAccess(scopeId: string, settings = this.host.store.getChatSettings(scopeId)): ResolvedAccessMode {
    return resolveAccessMode(this.host.config, settings);
  }

  shouldAllowInteractiveUserInput(scopeId: string, settings = this.host.store.getChatSettings(scopeId)): boolean {
    return (settings?.collaborationMode ?? null) === 'plan';
  }

  shouldRequirePlanConfirmation(scopeId: string, settings = this.host.store.getChatSettings(scopeId)): boolean {
    return (settings?.collaborationMode ?? null) === 'plan'
      && (settings?.confirmPlanBeforeExecute ?? true);
  }

  async handleModeCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
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
    const clearedPlanSessions = await this.applyCollaborationMode(scopeId, nextMode, locale);
    const lines = [
      t(locale, 'callback_mode', {
        value: formatCollaborationModeLabel(locale, nextMode),
      }),
      t(locale, 'line_scope', { value: formatTelegramScopeLabel(locale, scopeId) }),
    ];
    if (clearedPlanSessions > 0) {
      lines.push(t(locale, 'mode_pending_plans_cleared', { value: clearedPlanSessions }));
    }
    await this.host.messages.sendMessage(scopeId, lines.join('\n'));
  }

  async handlePlanAliasCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const normalized = args.join(' ').trim().toLowerCase();
    if (!normalized || normalized === 'on' || normalized === 'enable' || normalized === 'enabled') {
      await this.applyCollaborationMode(event.scopeId, 'plan', locale);
      await this.host.messages.sendMessage(event.scopeId, [
        t(locale, 'callback_mode', {
          value: formatCollaborationModeLabel(locale, 'plan'),
        }),
        t(locale, 'line_scope', { value: formatTelegramScopeLabel(locale, event.scopeId) }),
      ].join('\n'));
      return;
    }
    if (normalized === 'off' || normalized === 'disable' || normalized === 'disabled' || normalized === 'default') {
      const clearedPlanSessions = await this.applyCollaborationMode(event.scopeId, null, locale);
      const lines = [
        t(locale, 'callback_mode', {
          value: formatCollaborationModeLabel(locale, null),
        }),
        t(locale, 'line_scope', { value: formatTelegramScopeLabel(locale, event.scopeId) }),
      ];
      if (clearedPlanSessions > 0) {
        lines.push(t(locale, 'mode_pending_plans_cleared', { value: clearedPlanSessions }));
      }
      await this.host.messages.sendMessage(event.scopeId, lines.join('\n'));
      return;
    }
    await this.showModeSettingsPanel(event.scopeId, undefined, locale);
  }

  async handleModelCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    if (args.length === 0) {
      await this.showModelSettingsPanel(scopeId, undefined, locale);
      return;
    }
    if (this.host.turns.findByScope(scopeId)) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'model_change_blocked'));
      return;
    }
    const settings = this.host.store.getChatSettings(scopeId);
    const raw = args.join(' ').trim();
    const models = await this.host.app.listModels();
    if (raw === '' || raw.toLowerCase() === 'default' || raw.toLowerCase() === 'reset') {
      const defaultModel = resolveCurrentModel(models, null);
      const nextEffort = clampEffortToModel(defaultModel, settings?.reasoningEffort ?? null);
      this.host.store.setChatSettings(scopeId, null, nextEffort.effort);
      const lines = [
        t(locale, 'model_reset'),
        t(locale, 'status_configured_effort', { value: nextEffort.effort ?? t(locale, 'server_default') }),
        t(locale, 'applies_next_turn'),
        t(locale, 'tip_use_models'),
      ];
      if (nextEffort.adjustedFrom) {
        lines.splice(1, 0, t(locale, 'effort_adjusted_default_model', { effort: nextEffort.adjustedFrom }));
      }
      await this.host.messages.sendMessage(scopeId, lines.join('\n'));
      return;
    }
    const selected = resolveRequestedModel(models, raw);
    if (!selected) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'unknown_model', { model: raw }));
      return;
    }
    const nextEffort = clampEffortToModel(selected, settings?.reasoningEffort ?? null);
    this.host.store.setChatSettings(scopeId, selected.model, nextEffort.effort);
    const lines = [
      t(locale, 'model_configured', { model: selected.model }),
      t(locale, 'status_configured_effort', { value: nextEffort.effort ?? t(locale, 'server_default') }),
      t(locale, 'applies_next_turn'),
      t(locale, 'tip_use_models'),
    ];
    if (nextEffort.adjustedFrom) {
      lines.splice(1, 0, t(locale, 'effort_adjusted_model', { effort: nextEffort.adjustedFrom, model: selected.model }));
    }
    await this.host.messages.sendMessage(scopeId, lines.join('\n'));
  }

  async handleEffortCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    if (args.length === 0) {
      await this.showModelSettingsPanel(scopeId, undefined, locale);
      return;
    }
    if (this.host.turns.findByScope(scopeId)) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'effort_change_blocked'));
      return;
    }
    const settings = this.host.store.getChatSettings(scopeId);
    const models = await this.host.app.listModels();
    const currentModel = resolveCurrentModel(models, settings?.model ?? null);
    const raw = args.join(' ').trim().toLowerCase();
    if (raw === 'default' || raw === 'reset') {
      this.host.store.setChatSettings(scopeId, settings?.model ?? null, null);
      await this.host.messages.sendMessage(scopeId, [
        t(locale, 'effort_reset'),
        t(locale, 'applies_next_turn'),
        t(locale, 'tip_use_models'),
      ].join('\n'));
      return;
    }
    const effort = normalizeRequestedEffort(raw);
    if (!effort) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'usage_effort'));
      return;
    }
    if (currentModel && currentModel.supportedReasoningEfforts.length > 0 && !currentModel.supportedReasoningEfforts.includes(effort)) {
      await this.host.messages.sendMessage(
        scopeId,
        t(locale, 'model_does_not_support_effort', {
          model: currentModel.model,
          effort,
          supported: currentModel.supportedReasoningEfforts.join(', '),
        }),
      );
      return;
    }
    this.host.store.setChatSettings(scopeId, settings?.model ?? null, effort);
    await this.host.messages.sendMessage(scopeId, [
      t(locale, 'effort_configured', { effort }),
      t(locale, 'applies_next_turn'),
      t(locale, 'tip_use_models'),
    ].join('\n'));
  }

  async handleTierCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    if (args.length === 0) {
      await this.showModelSettingsPanel(scopeId, undefined, locale);
      return;
    }
    if (this.host.turns.findByScope(scopeId)) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'tier_change_blocked'));
      return;
    }
    const nextTier = normalizeRequestedServiceTier(args.join(' '));
    if (nextTier === undefined) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'usage_tier'));
      return;
    }
    await this.applyServiceTier(scopeId, nextTier, locale);
  }

  async handleFastCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    const scopeId = event.scopeId;
    if (this.host.turns.findByScope(scopeId)) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'tier_change_blocked'));
      return;
    }
    const normalized = args.join(' ').trim().toLowerCase();
    const nextTier = !normalized ? 'fast' : normalizeRequestedServiceTier(normalized);
    if (nextTier === undefined) {
      await this.showModelSettingsPanel(scopeId, undefined, locale);
      return;
    }
    await this.applyServiceTier(scopeId, nextTier === null && !normalized ? 'fast' : nextTier, locale);
  }

  async handleSettingsCallback(
    event: TelegramCallbackEvent,
    kind: 'model' | 'effort' | 'tier' | 'mode' | 'access',
    rawValue: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if ((kind === 'model' || kind === 'effort' || kind === 'tier') && this.host.turns.findByScope(scopeId)) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
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
    const models = await this.host.app.listModels();
    const settings = this.host.store.getChatSettings(scopeId);
    const value = kind === 'model' ? decodeURIComponent(rawValue) : rawValue;
    if (kind === 'model') {
      if (value === 'default') {
        const defaultModel = resolveCurrentModel(models, null);
        const nextEffort = clampEffortToModel(defaultModel, settings?.reasoningEffort ?? null);
        this.host.store.setChatSettings(scopeId, null, nextEffort.effort);
        await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'using_server_default_model'));
        return;
      }
      const selected = resolveRequestedModel(models, value);
      if (!selected) {
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'model_no_longer_available'));
        return;
      }
      const nextEffort = clampEffortToModel(selected, settings?.reasoningEffort ?? null);
      this.host.store.setChatSettings(scopeId, selected.model, nextEffort.effort);
      await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'callback_model', { model: selected.model }));
      return;
    }
    if (kind === 'tier') {
      const nextTier = normalizeRequestedServiceTier(value);
      if (nextTier === undefined) {
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
        return;
      }
      this.host.store.setChatServiceTier(scopeId, nextTier);
      await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
      await this.host.answerCallback(event.callbackQueryId, nextTier === null
        ? t(locale, 'using_default_service_tier')
        : t(locale, 'callback_service_tier', { value: formatServiceTierLabel(locale, nextTier) }));
      return;
    }
    if (value === 'default') {
      this.host.store.setChatSettings(scopeId, settings?.model ?? null, null);
      await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'using_default_effort'));
      return;
    }
    const effort = normalizeRequestedEffort(value);
    if (!effort) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'unknown_effort'));
      return;
    }
    const currentModel = resolveCurrentModel(models, settings?.model ?? null);
    if (currentModel && currentModel.supportedReasoningEfforts.length > 0 && !currentModel.supportedReasoningEfforts.includes(effort)) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'effort_not_supported_by_model'));
      return;
    }
    this.host.store.setChatSettings(scopeId, settings?.model ?? null, effort);
    await this.refreshModelSettingsPanel(scopeId, event.messageId, locale, models);
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'callback_effort', { effort }));
  }

  async handleGuidedPlanSettingsCallback(
    event: TelegramCallbackEvent,
    kind: 'plan-gate' | 'queue' | 'history',
    rawValue: 'on' | 'off',
    locale: AppLocale,
  ): Promise<void> {
    const enabled = rawValue === 'on';
    this.host.store.setChatGuidedPlanPreferences(event.scopeId, kind === 'plan-gate'
      ? { confirmPlanBeforeExecute: enabled }
      : kind === 'queue'
        ? { autoQueueMessages: enabled }
        : { persistPlanHistory: enabled });
    await this.showSettingsHomePanel(event.scopeId, event.messageId, locale);
    await this.host.answerCallback(
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

  async handleNavigationCallback(
    event: TelegramCallbackEvent,
    target: 'models' | 'mode' | 'threads' | 'reveal' | 'permissions',
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if (target === 'models') {
      await this.showModelSettingsPanel(scopeId, event.messageId, locale);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'opened_model_settings'));
      return;
    }
    if (target === 'mode') {
      await this.showModeSettingsPanel(scopeId, event.messageId, locale);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'opened_mode_settings'));
      return;
    }
    if (target === 'permissions') {
      await this.showAccessSettingsPanel(scopeId, event.messageId, locale);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'opened_access_settings'));
      return;
    }
    if (target === 'threads') {
      await this.host.threadPanels.showThreadsPanel(scopeId, event.messageId, undefined, locale);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'opened_thread_list'));
      return;
    }
    const binding = this.host.store.getBinding(scopeId);
    if (!binding) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'no_thread_bound_callback'));
      return;
    }
    const readyBinding = await this.host.sessions.ensureThreadReady(scopeId, binding);
    const revealError = await this.host.sessions.tryRevealThread(scopeId, readyBinding.threadId, 'reveal');
    await this.host.answerCallback(
      event.callbackQueryId,
      revealError ? t(locale, 'reveal_failed', { error: revealError }) : t(locale, 'opened_in_codex_short'),
    );
  }

  async showWherePanel(scopeId: string, messageId?: number, locale = this.host.localeForChat(scopeId)): Promise<void> {
    const binding = this.host.store.getBinding(scopeId);
    const settings = this.host.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    if (!binding) {
      const text = [
        t(locale, 'where_no_thread_bound'),
        t(locale, 'where_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
        t(locale, 'where_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
        t(locale, 'where_configured_service_tier', { value: formatServiceTierLabel(locale, settings?.serviceTier ?? null) }),
        t(locale, 'where_mode', { value: formatCollaborationModeLabel(locale, settings?.collaborationMode ?? null) }),
        t(locale, 'where_access_preset', { value: formatAccessPresetLabel(locale, access.preset) }),
        t(locale, 'where_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy) }),
        t(locale, 'where_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode) }),
        t(locale, 'where_send_message_or_new'),
      ].join('\n');
      if (messageId !== undefined) {
        await this.host.messages.editMessage(scopeId, messageId, text, whereKeyboard(locale, false));
        return;
      }
      await this.host.messages.sendMessage(scopeId, text, whereKeyboard(locale, false));
      return;
    }
    const readyBinding = await this.host.sessions.ensureThreadReady(scopeId, binding);
    const thread = await this.host.app.readThread(readyBinding.threadId, false);
    if (!thread) {
      const text = t(locale, 'where_thread_unavailable', { threadId: readyBinding.threadId });
      if (messageId !== undefined) {
        await this.host.messages.editMessage(scopeId, messageId, text, whereKeyboard(locale, false));
        return;
      }
      await this.host.messages.sendMessage(scopeId, text, whereKeyboard(locale, false));
      return;
    }
    const threadWithDisplayName = {
      ...thread,
      name: this.host.store.getThreadNameOverride(scopeId, thread.threadId) ?? thread.name,
    };
    const text = formatWhereMessage(locale, threadWithDisplayName, settings, this.host.config.defaultCwd, access);
    if (messageId !== undefined) {
      await this.host.messages.editMessage(scopeId, messageId, text, whereKeyboard(locale, true));
      return;
    }
    await this.host.messages.sendMessage(scopeId, text, whereKeyboard(locale, true));
  }

  async showModelSettingsPanel(scopeId: string, messageId?: number, locale = this.host.localeForChat(scopeId)): Promise<void> {
    const models = await this.host.app.listModels();
    const settings = this.host.store.getChatSettings(scopeId);
    const text = formatModelSettingsMessage(locale, models, settings);
    const keyboard = buildModelSettingsKeyboard(locale, models, settings);
    if (messageId !== undefined) {
      await this.host.messages.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.host.messages.sendHtmlMessage(scopeId, text, keyboard);
  }

  async showModeSettingsPanel(scopeId: string, messageId?: number, locale = this.host.localeForChat(scopeId)): Promise<void> {
    const settings = this.host.store.getChatSettings(scopeId);
    const text = formatModeSettingsMessage(locale, scopeId, settings);
    const keyboard = buildModeSettingsKeyboard(locale, settings);
    if (messageId !== undefined) {
      await this.host.messages.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.host.messages.sendHtmlMessage(scopeId, text, keyboard);
  }

  async showAccessSettingsPanel(scopeId: string, messageId?: number, locale = this.host.localeForChat(scopeId)): Promise<void> {
    const access = this.resolveEffectiveAccess(scopeId);
    const text = formatAccessSettingsMessage(locale, access);
    const keyboard = buildAccessSettingsKeyboard(locale, access);
    if (messageId !== undefined) {
      await this.host.messages.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.host.messages.sendHtmlMessage(scopeId, text, keyboard);
  }

  async showSettingsHomePanel(scopeId: string, messageId?: number, locale = this.host.localeForChat(scopeId)): Promise<void> {
    const binding = this.host.store.getBinding(scopeId);
    const settings = this.host.store.getChatSettings(scopeId);
    const access = this.resolveEffectiveAccess(scopeId, settings);
    const text = formatSettingsHomeMessage(locale, {
      scopeId,
      threadId: binding?.threadId ?? null,
      cwd: binding?.cwd ?? this.host.config.defaultCwd,
      settings,
      access,
      queueDepth: this.host.store.countQueuedTurnInputs(scopeId),
      activeTurnId: this.host.turns.findByScope(scopeId)?.turnId ?? null,
    });
    const keyboard = buildSettingsHomeKeyboard(locale, settings);
    if (messageId !== undefined) {
      await this.host.messages.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.host.messages.sendHtmlMessage(scopeId, text, keyboard);
  }

  private async handleAccessSettingsCallback(event: TelegramCallbackEvent, rawValue: string, locale: AppLocale): Promise<void> {
    const nextPreset = normalizeAccessPreset(rawValue);
    if (!nextPreset) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    this.host.store.setChatAccessPreset(event.scopeId, nextPreset);
    await this.refreshAccessSettingsPanel(event.scopeId, event.messageId, locale);
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'callback_access', {
      value: formatAccessPresetLabel(locale, nextPreset),
    }));
  }

  private async handleModeSettingsCallback(event: TelegramCallbackEvent, rawValue: string, locale: AppLocale): Promise<void> {
    const nextMode = normalizeRequestedCollaborationMode(rawValue);
    if (!nextMode && rawValue !== 'default') {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    await this.applyCollaborationMode(event.scopeId, nextMode, locale);
    await this.refreshModeSettingsPanel(event.scopeId, event.messageId, locale);
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'callback_mode', {
      value: formatCollaborationModeLabel(locale, nextMode),
    }));
  }

  private async applyServiceTier(scopeId: string, serviceTier: ServiceTierValue | null, locale: AppLocale): Promise<void> {
    this.host.store.setChatServiceTier(scopeId, serviceTier);
    await this.host.messages.sendMessage(scopeId, [
      serviceTier === null
        ? t(locale, 'service_tier_reset')
        : t(locale, 'service_tier_configured', { value: formatServiceTierLabel(locale, serviceTier) }),
      t(locale, 'applies_next_turn'),
      t(locale, 'tip_use_models'),
    ].join('\n'));
  }

  private async refreshModelSettingsPanel(scopeId: string, messageId: number, locale: AppLocale, models?: ModelInfo[]): Promise<void> {
    const resolvedModels = models ?? await this.host.app.listModels();
    const settings = this.host.store.getChatSettings(scopeId);
    await this.host.messages.editHtmlMessage(
      scopeId,
      messageId,
      formatModelSettingsMessage(locale, resolvedModels, settings),
      buildModelSettingsKeyboard(locale, resolvedModels, settings),
    );
  }

  private async refreshModeSettingsPanel(scopeId: string, messageId: number, locale: AppLocale): Promise<void> {
    const settings = this.host.store.getChatSettings(scopeId);
    await this.host.messages.editHtmlMessage(
      scopeId,
      messageId,
      formatModeSettingsMessage(locale, scopeId, settings),
      buildModeSettingsKeyboard(locale, settings),
    );
  }

  private async applyCollaborationMode(scopeId: string, nextMode: 'default' | 'plan' | null, locale: AppLocale): Promise<number> {
    const normalizedMode = nextMode === 'plan' ? 'plan' : null;
    this.host.store.setChatCollaborationMode(scopeId, normalizedMode);
    if (normalizedMode === 'plan') {
      return 0;
    }
    const clearedPlanSessions = this.host.store.cancelOpenPlanSessions(scopeId, [
      'drafting_plan',
      'awaiting_plan_confirmation',
      'recovery_required',
    ]);
    await this.host.clearPendingUserInputsIfNeeded(scopeId, locale);
    return clearedPlanSessions;
  }

  private async refreshAccessSettingsPanel(scopeId: string, messageId: number, locale: AppLocale): Promise<void> {
    const access = this.resolveEffectiveAccess(scopeId);
    await this.host.messages.editHtmlMessage(
      scopeId,
      messageId,
      formatAccessSettingsMessage(locale, access),
      buildAccessSettingsKeyboard(locale, access),
    );
  }
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
