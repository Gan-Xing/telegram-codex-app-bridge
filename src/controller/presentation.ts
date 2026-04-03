import path from 'node:path';
import type { BridgeEngineValue } from '../config.js';
import { t } from '../i18n.js';
import { parseTelegramScopeId } from '../telegram/scope.js';
import type {
  AccessPresetValue,
  AppLocale,
  AppThread,
  ApprovalPolicyValue,
  ChatSessionSettings,
  CollaborationModeValue,
  GeminiApprovalModeValue,
  ModelInfo,
  ReasoningEffortValue,
  SandboxModeValue,
  ServiceTierValue,
} from '../types.js';
import type { ResolvedAccessMode } from './access.js';

type InlineButton = { text: string; callback_data: string };

interface ThreadLike {
  index?: number;
  threadId: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  modelProvider: string | null;
  status: AppThread['status'];
  updatedAt: number;
}

export type ThreadHistoryPreviewStatus = 'complete' | 'partial' | 'failed' | 'interrupted';

export interface ThreadListPresentationState {
  offset: number;
  pageSize: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  searchTerm?: string | null;
}

export interface ThreadHistoryPreviewTurn {
  userText: string | null;
  assistantText: string | null;
  status: ThreadHistoryPreviewStatus;
}

export function formatThreadsMessage(
  locale: AppLocale,
  threads: ThreadLike[],
  currentThreadId: string | null,
  searchTerm?: string | null,
  state?: ThreadListPresentationState,
): string {
  if (threads.length === 0) {
    return searchTerm
      ? t(locale, 'threads_no_matches', { searchTerm: escapeTelegramHtml(searchTerm) })
      : t(locale, 'threads_no_recent');
  }
  const currentThread = currentThreadId
    ? threads.find(thread => thread.threadId === currentThreadId) ?? null
    : null;
  const headerLines = [
    t(locale, 'threads_recent_title'),
    t(locale, 'threads_tap_to_open'),
  ];
  if (searchTerm) {
    headerLines.push(t(locale, 'threads_filter', { searchTerm: escapeTelegramHtml(searchTerm) }));
  }
  if (state) {
    headerLines.push(t(locale, 'threads_range', {
      start: state.offset + 1,
      end: state.offset + threads.length,
    }));
  }
  if (currentThread) {
    const currentTitle = truncate(compactWhitespace(currentThread.name || currentThread.preview || t(locale, 'empty')), 40);
    headerLines.push(t(locale, 'threads_current', { title: escapeTelegramHtml(currentTitle) }));
    headerLines.push(escapeTelegramHtml([
      formatCwd(locale, currentThread.cwd),
      formatRelativeTime(locale, currentThread.updatedAt),
      formatStatusLabel(locale, currentThread.status),
    ].filter(Boolean).join(' | ')));
  }
  return headerLines.join('\n');
}

export function buildThreadsKeyboard(locale: AppLocale, threads: ThreadLike[]): Array<Array<{ text: string; callback_data: string }>> {
  return threads.map((thread, index) => {
    const ordinal = typeof thread.index === 'number' ? thread.index + 1 : index + 1;
    const title = `${ordinal}. ${truncate(compactWhitespace(thread.name || thread.preview || t(locale, 'empty')), 22)}`;
    return [
      { text: title, callback_data: `thread:open:${thread.threadId}` },
      { text: t(locale, 'button_rename'), callback_data: `thread:rename:start:${thread.threadId}` },
    ];
  });
}

export function buildThreadListKeyboard(
  locale: AppLocale,
  threads: ThreadLike[],
  state: ThreadListPresentationState,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows = buildThreadsKeyboard(locale, threads);
  const navigationRow: InlineButton[] = [];
  if (state.hasPreviousPage) {
    navigationRow.push({ text: t(locale, 'button_prev_page'), callback_data: 'thread:list:prev' });
  }
  if (state.hasNextPage) {
    navigationRow.push({ text: t(locale, 'button_next_page'), callback_data: 'thread:list:next' });
  }
  if (navigationRow.length > 0) {
    rows.push(navigationRow);
  }
  if (state.searchTerm) {
    rows.push([{ text: t(locale, 'button_clear_filter'), callback_data: 'thread:list:clear' }]);
  }
  return rows;
}

export function formatThreadHistoryPreviewMessage(
  locale: AppLocale,
  thread: Pick<ThreadLike, 'threadId' | 'name' | 'preview'>,
  turns: ThreadHistoryPreviewTurn[],
): string {
  const title = truncate(compactWhitespace(thread.name || thread.preview || t(locale, 'untitled')), 48);
  const lines = [
    `<b>${escapeTelegramHtml(t(locale, 'thread_history_title'))}</b>`,
    t(locale, 'thread_history_switched_to', { value: escapeTelegramHtml(title) }),
    t(locale, 'thread_history_thread_id', { value: escapeTelegramHtml(thread.threadId) }),
  ];
  if (turns.length === 0) {
    lines.push('', escapeTelegramHtml(t(locale, 'thread_history_empty')));
    return lines.join('\n');
  }
  lines.push('', escapeTelegramHtml(t(locale, 'thread_history_recent_turns')));
  for (const [index, turn] of turns.entries()) {
    const userText = truncate(compactWhitespace(turn.userText || t(locale, 'empty')), 220);
    const assistantText = truncate(compactWhitespace(turn.assistantText || t(locale, 'thread_history_no_reply')), 280);
    lines.push('');
    lines.push(`<b>${escapeTelegramHtml(t(locale, 'thread_history_turn_label', { value: index + 1 }))}</b>`);
    lines.push(`${escapeTelegramHtml(t(locale, 'thread_history_you'))}: ${escapeTelegramHtml(userText)}`);
    lines.push(`${escapeTelegramHtml(formatThreadHistoryAssistantLabel(locale, turn.status))}: ${escapeTelegramHtml(assistantText)}`);
  }
  return lines.join('\n');
}

export function formatWhereMessage(
  locale: AppLocale,
  engine: BridgeEngineValue,
  thread: AppThread,
  settings: ChatSessionSettings | null,
  defaultCwd: string,
  access: ResolvedAccessMode,
  options: {
    showEffort?: boolean;
    showServiceTier?: boolean;
    showMode?: boolean;
    showAccess?: boolean;
  } = {},
): string {
  const showEffort = options.showEffort ?? true;
  const showServiceTier = options.showServiceTier ?? true;
  const showMode = options.showMode ?? true;
  const showAccess = options.showAccess ?? true;
  return [
    t(locale, 'where_thread', { value: thread.threadId }),
    t(locale, 'where_title', { value: thread.name || t(locale, 'untitled') }),
    t(locale, 'where_preview', { value: thread.preview || t(locale, 'empty') }),
    t(locale, 'where_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
    showEffort ? t(locale, 'where_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }) : null,
    showServiceTier ? t(locale, 'where_configured_service_tier', { value: formatServiceTierLabel(locale, settings?.serviceTier ?? null) }) : null,
    showMode ? t(locale, 'where_mode', { value: formatEngineModeLabel(locale, engine, settings) }) : null,
    showAccess ? t(locale, 'where_access_preset', { value: formatAccessPresetLabel(locale, access.preset) }) : null,
    showAccess ? t(locale, 'where_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy) }) : null,
    showAccess ? t(locale, 'where_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode) }) : null,
    t(locale, 'where_provider', { value: thread.modelProvider ?? t(locale, 'unknown') }),
    t(locale, 'where_status', { value: formatStatus(locale, thread.status) }),
    t(locale, 'where_cwd', { value: thread.cwd ?? defaultCwd }),
    t(locale, 'where_updated', { value: formatIsoTime(locale, thread.updatedAt) }),
  ].filter(Boolean).join('\n');
}

export function formatAccessSettingsMessage(locale: AppLocale, access: ResolvedAccessMode): string {
  return [
    t(locale, 'permissions_title'),
    t(locale, 'permissions_tap_to_change'),
    '',
    t(locale, 'permissions_preset', { value: escapeTelegramHtml(formatAccessPresetLabel(locale, access.preset)) }),
    t(locale, 'permissions_approval_policy', { value: escapeTelegramHtml(formatApprovalPolicyLabel(locale, access.approvalPolicy)) }),
    t(locale, 'permissions_sandbox_mode', { value: escapeTelegramHtml(formatSandboxModeLabel(locale, access.sandboxMode)) }),
  ].join('\n');
}

export function formatSettingsHomeMessage(
  locale: AppLocale,
  state: {
    scopeId: string;
    engine: BridgeEngineValue;
    instanceId: string | null;
    threadId: string | null;
    cwd: string | null;
    settings: ChatSessionSettings | null;
    access: ResolvedAccessMode;
    queueDepth: number;
    activeTurnId: string | null;
  },
  options: {
    showEffort?: boolean;
    showServiceTier?: boolean;
    showMode?: boolean;
    showAccess?: boolean;
    showPlanControls?: boolean;
  } = {},
): string {
  const showEffort = options.showEffort ?? true;
  const showServiceTier = options.showServiceTier ?? true;
  const showMode = options.showMode ?? true;
  const showAccess = options.showAccess ?? true;
  const showPlanControls = options.showPlanControls ?? true;
  return [
    t(locale, 'settings_home_title'),
    t(locale, 'settings_home_hint'),
    '',
    t(locale, 'status_engine', { value: escapeTelegramHtml(formatBridgeEngineLabel(locale, state.engine)) }),
    t(locale, 'status_instance', { value: escapeTelegramHtml(state.instanceId ?? t(locale, 'none')) }),
    t(locale, 'line_scope', { value: escapeTelegramHtml(formatTelegramScopeLabel(locale, state.scopeId)) }),
    t(locale, 'settings_current_thread', { value: escapeTelegramHtml(state.threadId ?? t(locale, 'none')) }),
    t(locale, 'line_cwd', { value: escapeTelegramHtml(state.cwd ?? t(locale, 'no_cwd')) }),
    state.activeTurnId ? t(locale, 'settings_active_turn', { value: escapeTelegramHtml(state.activeTurnId) }) : null,
    t(locale, 'settings_queue_depth', { value: state.queueDepth }),
    '',
    t(locale, 'status_configured_model', { value: escapeTelegramHtml(state.settings?.model ?? t(locale, 'server_default')) }),
    showEffort
      ? t(locale, 'status_configured_effort', { value: escapeTelegramHtml(state.settings?.reasoningEffort ?? t(locale, 'server_default')) })
      : null,
    showServiceTier
      ? t(locale, 'status_configured_service_tier', { value: escapeTelegramHtml(formatServiceTierLabel(locale, state.settings?.serviceTier ?? null)) })
      : null,
    showMode
      ? t(locale, 'status_mode', { value: escapeTelegramHtml(formatEngineModeLabel(locale, state.engine, state.settings)) })
      : null,
    showAccess
      ? t(locale, 'status_access_preset', { value: escapeTelegramHtml(formatAccessPresetLabel(locale, state.access.preset)) })
      : null,
    showPlanControls ? t(locale, 'settings_plan_gate', {
      value: t(locale, (state.settings?.confirmPlanBeforeExecute ?? true) ? 'yes' : 'no'),
    }) : null,
    t(locale, 'settings_auto_queue', {
      value: t(locale, (state.settings?.autoQueueMessages ?? true) ? 'yes' : 'no'),
    }),
    showPlanControls ? t(locale, 'settings_plan_history', {
      value: t(locale, (state.settings?.persistPlanHistory ?? true) ? 'yes' : 'no'),
    }) : null,
  ].filter(Boolean).join('\n');
}

export function formatModeSettingsMessage(
  locale: AppLocale,
  engine: BridgeEngineValue,
  scopeId: string,
  settings: ChatSessionSettings | null,
): string {
  return [
    t(locale, 'mode_title'),
    engine === 'gemini' ? t(locale, 'mode_tap_to_change_gemini') : t(locale, 'mode_tap_to_change_codex'),
    '',
    t(locale, 'line_scope', { value: escapeTelegramHtml(formatTelegramScopeLabel(locale, scopeId)) }),
    t(locale, 'mode_current', { value: escapeTelegramHtml(formatEngineModeLabel(locale, engine, settings)) }),
  ].join('\n');
}

export function buildModeSettingsKeyboard(
  locale: AppLocale,
  engine: BridgeEngineValue,
  settings: ChatSessionSettings | null,
): InlineButton[][] {
  if (engine === 'gemini') {
    const current = settings?.geminiApprovalMode ?? null;
    return [[
      {
        text: `${current === null || current === 'default' ? '• ' : ''}${t(locale, 'mode_default')}`,
        callback_data: 'settings:mode:default',
      },
      {
        text: `${current === 'auto_edit' ? '• ' : ''}${t(locale, 'mode_auto_edit')}`,
        callback_data: 'settings:mode:auto_edit',
      },
    ], [
      {
        text: `${current === 'yolo' ? '• ' : ''}${t(locale, 'mode_yolo')}`,
        callback_data: 'settings:mode:yolo',
      },
      {
        text: `${current === 'plan' ? '• ' : ''}${t(locale, 'mode_plan')}`,
        callback_data: 'settings:mode:plan',
      },
    ], [
      {
        text: t(locale, 'button_settings_home'),
        callback_data: 'settings:home',
      },
    ]];
  }
  const current = settings?.collaborationMode ?? null;
  return [[
    {
      text: `${current === null || current === 'default' ? '• ' : ''}${t(locale, 'mode_default')}`,
      callback_data: 'settings:mode:default',
    },
    {
      text: `${current === 'plan' ? '• ' : ''}${t(locale, 'mode_plan')}`,
      callback_data: 'settings:mode:plan',
    },
  ], [
    {
      text: t(locale, 'button_settings_home'),
      callback_data: 'settings:home',
    },
  ]];
}

export function buildAccessSettingsKeyboard(locale: AppLocale, access: ResolvedAccessMode): InlineButton[][] {
  const currentPreset = access.preset;
  const buttons: InlineButton[] = [
    {
      text: `${currentPreset === 'read-only' ? '• ' : ''}${t(locale, 'access_preset_read_only')}`,
      callback_data: 'settings:access:read-only',
    },
    {
      text: `${currentPreset === 'default' ? '• ' : ''}${t(locale, 'access_preset_default')}`,
      callback_data: 'settings:access:default',
    },
    {
      text: `${currentPreset === 'full-access' ? '• ' : ''}${t(locale, 'access_preset_full_access')}`,
      callback_data: 'settings:access:full-access',
    },
  ];
  return [buttons, [{
    text: t(locale, 'button_settings_home'),
    callback_data: 'settings:home',
  }]];
}

export function formatModelSettingsMessage(
  locale: AppLocale,
  models: ModelInfo[],
  settings: ChatSessionSettings | null,
  options: {
    showEffort?: boolean;
    showServiceTier?: boolean;
  } = {},
): string {
  const showEffort = options.showEffort ?? true;
  const showServiceTier = options.showServiceTier ?? true;
  const selectedModel = resolveCurrentModel(models, settings?.model ?? null);
  const selectedModelLabel = settings?.model ?? t(locale, 'server_default');
  const selectedEffort = settings?.reasoningEffort ?? null;
  const selectedServiceTier = settings?.serviceTier ?? null;
  const supportedEfforts = selectedModel?.supportedReasoningEfforts.length
    ? selectedModel.supportedReasoningEfforts
    : selectedModel
      ? [selectedModel.defaultReasoningEffort]
      : [];

  return [
    t(locale, 'models_title'),
    t(locale, 'models_tap_to_change'),
    '',
    t(locale, 'models_model', { value: escapeTelegramHtml(selectedModelLabel) }),
    showEffort ? t(locale, 'models_effort', { value: escapeTelegramHtml(selectedEffort ?? t(locale, 'server_default')) }) : null,
    showServiceTier ? t(locale, 'models_service_tier', { value: escapeTelegramHtml(formatServiceTierLabel(locale, selectedServiceTier)) }) : null,
    selectedModel ? t(locale, 'models_current_default_target', { value: escapeTelegramHtml(selectedModel.model) }) : null,
    showEffort && supportedEfforts.length > 0
      ? t(locale, 'models_supported_efforts', { value: escapeTelegramHtml(supportedEfforts.join(', ')) })
      : showEffort
        ? t(locale, 'models_supported_efforts_unknown')
        : null,
  ].filter(Boolean).join('\n');
}

export function buildModelSettingsKeyboard(
  locale: AppLocale,
  models: ModelInfo[],
  settings: ChatSessionSettings | null,
  options: {
    showEffort?: boolean;
    showServiceTier?: boolean;
  } = {},
): InlineButton[][] {
  const showEffort = options.showEffort ?? true;
  const showServiceTier = options.showServiceTier ?? true;
  const currentModel = settings?.model ?? null;
  const effectiveModel = resolveCurrentModel(models, currentModel);
  const efforts = effectiveModel?.supportedReasoningEfforts.length
    ? effectiveModel.supportedReasoningEfforts
    : effectiveModel
      ? [effectiveModel.defaultReasoningEffort]
      : ['medium'];

  const modelButtons: InlineButton[] = [
    {
      text: currentModel === null ? `• ${t(locale, 'button_auto')}` : t(locale, 'button_auto'),
      callback_data: 'settings:model:default',
    },
    ...models.map((model) => ({
      text: `${currentModel === model.model ? '• ' : ''}${truncate(model.model, 14)}`,
      callback_data: `settings:model:${encodeURIComponent(model.model)}`,
    })),
  ];

  const effortButtons: InlineButton[] = [
    {
      text: settings?.reasoningEffort === null ? `• ${t(locale, 'button_auto')}` : t(locale, 'button_auto'),
      callback_data: 'settings:effort:default',
    },
    ...efforts.map((effort) => ({
      text: `${settings?.reasoningEffort === effort ? '• ' : ''}${effort}`,
      callback_data: `settings:effort:${effort}`,
    })),
  ];
  const serviceTierButtons: InlineButton[] = [
    {
      text: settings?.serviceTier === null ? `• ${t(locale, 'button_auto')}` : t(locale, 'button_auto'),
      callback_data: 'settings:tier:default',
    },
    {
      text: `${settings?.serviceTier === 'fast' ? '• ' : ''}${t(locale, 'service_tier_fast')}`,
      callback_data: 'settings:tier:fast',
    },
    {
      text: `${settings?.serviceTier === 'flex' ? '• ' : ''}${t(locale, 'service_tier_flex')}`,
      callback_data: 'settings:tier:flex',
    },
  ];

  return [
    ...chunkButtons(modelButtons, 2),
    ...(showEffort ? chunkButtons(effortButtons, 3) : []),
    ...(showServiceTier ? [serviceTierButtons] : []),
    [{
      text: t(locale, 'button_settings_home'),
      callback_data: 'settings:home',
    }],
  ];
}

export function buildSettingsHomeKeyboard(
  locale: AppLocale,
  settings: ChatSessionSettings | null,
  options: {
    showMode?: boolean;
    showAccess?: boolean;
    showPlanControls?: boolean;
  } = {},
): InlineButton[][] {
  const showMode = options.showMode ?? true;
  const showAccess = options.showAccess ?? true;
  const showPlanControls = options.showPlanControls ?? true;
  const planGateOn = settings?.confirmPlanBeforeExecute ?? true;
  const autoQueueOn = settings?.autoQueueMessages ?? true;
  const historyOn = settings?.persistPlanHistory ?? true;
  const navButtons: InlineButton[] = [
    { text: t(locale, 'button_models'), callback_data: 'nav:models' },
    ...(showMode ? [{ text: t(locale, 'button_mode'), callback_data: 'nav:mode' }] : []),
    ...(showAccess ? [{ text: t(locale, 'button_permissions'), callback_data: 'nav:permissions' }] : []),
  ];
  return [
    navButtons,
    ...(showPlanControls ? [[{
      text: t(locale, 'settings_toggle_plan_gate', { value: t(locale, planGateOn ? 'yes' : 'no') }),
      callback_data: `settings:plan-gate:${planGateOn ? 'off' : 'on'}`,
    }]] : []),
    [{
      text: t(locale, 'settings_toggle_auto_queue', { value: t(locale, autoQueueOn ? 'yes' : 'no') }),
      callback_data: `settings:queue:${autoQueueOn ? 'off' : 'on'}`,
    }],
    ...(showPlanControls ? [[{
      text: t(locale, 'settings_toggle_history', { value: t(locale, historyOn ? 'yes' : 'no') }),
      callback_data: `settings:history:${historyOn ? 'off' : 'on'}`,
    }]] : []),
  ];
}

export function resolveRequestedModel(models: ModelInfo[], requested: string): ModelInfo | null {
  const normalized = requested.trim().toLowerCase();
  return models.find(model => (
    model.model.toLowerCase() === normalized
    || model.id.toLowerCase() === normalized
    || model.displayName.toLowerCase() === normalized
  )) ?? null;
}

export function resolveCurrentModel(models: ModelInfo[], currentModel: string | null): ModelInfo | null {
  if (currentModel) {
    const current = resolveRequestedModel(models, currentModel);
    if (current) return current;
  }
  return models.find(model => model.isDefault) ?? null;
}

export function normalizeRequestedEffort(value: string): ReasoningEffortValue | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'none'
    || normalized === 'minimal'
    || normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'xhigh'
  ) {
    return normalized;
  }
  return null;
}

export function normalizeRequestedServiceTier(value: string): ServiceTierValue | null | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'auto' || normalized === 'default' || normalized === 'reset' || normalized === 'off') {
    return null;
  }
  if (normalized === 'fast' || normalized === 'on') {
    return 'fast';
  }
  if (normalized === 'flex') {
    return 'flex';
  }
  return undefined;
}

export function clampEffortToModel(
  model: ModelInfo | null,
  effort: ReasoningEffortValue | null,
): { effort: ReasoningEffortValue | null; adjustedFrom: ReasoningEffortValue | null } {
  if (!model || !effort) {
    return { effort, adjustedFrom: null };
  }
  if (model.supportedReasoningEfforts.includes(effort)) {
    return { effort, adjustedFrom: null };
  }
  return { effort: model.defaultReasoningEffort, adjustedFrom: effort };
}

export function formatAccessPresetLabel(locale: AppLocale, preset: AccessPresetValue): string {
  if (preset === 'read-only') return t(locale, 'access_preset_read_only');
  if (preset === 'full-access') return t(locale, 'access_preset_full_access');
  return t(locale, 'access_preset_default');
}

export function formatApprovalPolicyLabel(locale: AppLocale, policy: ApprovalPolicyValue): string {
  if (policy === 'never') return t(locale, 'approval_policy_never');
  if (policy === 'untrusted') return t(locale, 'approval_policy_untrusted');
  if (policy === 'on-failure') return t(locale, 'approval_policy_on_failure');
  return t(locale, 'approval_policy_on_request');
}

export function formatCollaborationModeLabel(locale: AppLocale, mode: CollaborationModeValue | null): string {
  if (mode === 'plan') return t(locale, 'mode_plan');
  return t(locale, 'mode_default');
}

export function formatGeminiApprovalModeLabel(locale: AppLocale, mode: GeminiApprovalModeValue | null | undefined): string {
  if (mode === 'auto_edit') return t(locale, 'mode_auto_edit');
  if (mode === 'yolo') return t(locale, 'mode_yolo');
  if (mode === 'plan') return t(locale, 'mode_plan');
  return t(locale, 'mode_default');
}

export function formatEngineModeLabel(
  locale: AppLocale,
  engine: BridgeEngineValue,
  settings: ChatSessionSettings | null,
): string {
  return engine === 'gemini'
    ? formatGeminiApprovalModeLabel(locale, settings?.geminiApprovalMode ?? null)
    : formatCollaborationModeLabel(locale, settings?.collaborationMode ?? null);
}

export function formatBridgeEngineLabel(locale: AppLocale, engine: BridgeEngineValue): string {
  return engine === 'gemini' ? t(locale, 'engine_gemini') : t(locale, 'engine_codex');
}

export function formatTelegramScopeLabel(locale: AppLocale, scopeId: string): string {
  try {
    const scope = parseTelegramScopeId(scopeId);
    if (scope.topicId === null) {
      return t(locale, 'scope_root', { chatId: scope.chatId });
    }
    return t(locale, 'scope_topic', { chatId: scope.chatId, topicId: scope.topicId });
  } catch {
    return scopeId;
  }
}

export function formatServiceTierLabel(locale: AppLocale, tier: ServiceTierValue | null): string {
  if (tier === 'fast') return t(locale, 'service_tier_fast');
  if (tier === 'flex') return t(locale, 'service_tier_flex');
  return t(locale, 'server_default');
}

export function formatSandboxModeLabel(locale: AppLocale, mode: SandboxModeValue): string {
  if (mode === 'danger-full-access') return t(locale, 'sandbox_mode_danger_full_access');
  if (mode === 'read-only') return t(locale, 'sandbox_mode_read_only');
  return t(locale, 'sandbox_mode_workspace_write');
}

function formatStatus(locale: AppLocale, status: AppThread['status']): string {
  switch (status) {
    case 'active':
      return t(locale, 'status_active');
    case 'notLoaded':
      return t(locale, 'status_not_loaded');
    case 'systemError':
      return t(locale, 'status_error');
    default:
      return t(locale, 'status_idle');
  }
}

function formatStatusLabel(locale: AppLocale, status: AppThread['status']): string {
  if (status === 'active') return t(locale, 'status_active');
  if (status === 'systemError') return t(locale, 'status_error');
  return '';
}

function formatCwd(locale: AppLocale, cwd: string | null): string {
  if (!cwd) return t(locale, 'no_cwd');
  const base = path.basename(cwd);
  return base || cwd;
}

function formatThreadHistoryAssistantLabel(locale: AppLocale, status: ThreadHistoryPreviewStatus): string {
  if (status === 'failed') return t(locale, 'thread_history_codex_failed');
  if (status === 'interrupted') return t(locale, 'thread_history_codex_interrupted');
  if (status === 'partial') return t(locale, 'thread_history_codex_partial');
  return t(locale, 'thread_history_codex');
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function formatRelativeTime(locale: AppLocale, unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return t(locale, 'unknown');
  const deltaSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(unixSeconds));
  if (locale === 'zh') {
    if (deltaSeconds < 60) return `${deltaSeconds}秒前`;
    if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}分钟前`;
    if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}小时前`;
    return `${Math.floor(deltaSeconds / 86_400)}天前`;
  }
  if (locale === 'fr') {
    if (deltaSeconds < 60) return `il y a ${deltaSeconds} s`;
    if (deltaSeconds < 3600) return `il y a ${Math.floor(deltaSeconds / 60)} min`;
    if (deltaSeconds < 86_400) return `il y a ${Math.floor(deltaSeconds / 3600)} h`;
    return `il y a ${Math.floor(deltaSeconds / 86_400)} j`;
  }
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}

function formatIsoTime(locale: AppLocale, unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return t(locale, 'unknown');
  return new Date(unixSeconds * 1000).toISOString();
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function chunkButtons(buttons: InlineButton[], width: number): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let index = 0; index < buttons.length; index += width) {
    rows.push(buttons.slice(index, index + width));
  }
  return rows;
}
