import path from 'node:path';
import { t } from '../i18n.js';
import type {
  AccessPresetValue,
  AppLocale,
  AppThread,
  ApprovalPolicyValue,
  ChatSessionSettings,
  ModelInfo,
  ReasoningEffortValue,
  SandboxModeValue,
} from '../types.js';
import type { ResolvedAccessMode } from './access.js';

type InlineButton = { text: string; callback_data: string };

interface ThreadLike {
  threadId: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  modelProvider: string | null;
  status: AppThread['status'];
  updatedAt: number;
}

export function formatThreadsMessage(
  locale: AppLocale,
  threads: ThreadLike[],
  currentThreadId: string | null,
  searchTerm?: string | null,
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
  return threads.map((thread, index) => [{
    text: `${index + 1}. ${truncate(compactWhitespace(thread.name || thread.preview || t(locale, 'empty')), 28)}`,
    callback_data: `thread:open:${thread.threadId}`,
  }]);
}

export function formatWhereMessage(
  locale: AppLocale,
  thread: AppThread,
  settings: ChatSessionSettings | null,
  defaultCwd: string,
  access: ResolvedAccessMode,
): string {
  return [
    t(locale, 'where_thread', { value: thread.threadId }),
    t(locale, 'where_title', { value: thread.name || t(locale, 'untitled') }),
    t(locale, 'where_preview', { value: thread.preview || t(locale, 'empty') }),
    t(locale, 'where_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
    t(locale, 'where_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
    t(locale, 'where_access_preset', { value: formatAccessPresetLabel(locale, access.preset) }),
    t(locale, 'where_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy) }),
    t(locale, 'where_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode) }),
    t(locale, 'where_provider', { value: thread.modelProvider ?? t(locale, 'unknown') }),
    t(locale, 'where_status', { value: formatStatus(locale, thread.status) }),
    t(locale, 'where_cwd', { value: thread.cwd ?? defaultCwd }),
    t(locale, 'where_updated', { value: formatIsoTime(locale, thread.updatedAt) }),
  ].join('\n');
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
  return [buttons];
}

/** Threads row shape for Weixin copy-paste lines (matches cached thread list fields). */
export interface WeixinCopyPasteThreadRow {
  threadId: string;
  name: string | null;
  preview: string;
}

export function formatWeixinThreadsCopyPaste(
  locale: AppLocale,
  threads: WeixinCopyPasteThreadRow[],
  searchTerm?: string | null,
): string {
  const lines: string[] = [
    t(locale, 'weixin_copy_paste_divider'),
    t(locale, 'weixin_copy_threads_title'),
  ];
  if (searchTerm?.trim()) {
    lines.push(t(locale, 'weixin_copy_threads_filter', { term: searchTerm.trim() }));
  }
  if (threads.length === 0) {
    lines.push(t(locale, 'weixin_copy_threads_empty'));
  } else {
    for (let i = 0; i < threads.length; i += 1) {
      lines.push(`/open ${i + 1}`);
    }
  }
  lines.push(t(locale, 'weixin_copy_threads_filter_hint'));
  return lines.join('\n');
}

export function formatWeixinModelCopyPaste(
  locale: AppLocale,
  models: ModelInfo[],
  settings: ChatSessionSettings | null,
): string {
  const effective = resolveCurrentModel(models, settings?.model ?? null);
  const efforts = effective?.supportedReasoningEfforts.length
    ? effective.supportedReasoningEfforts
    : effective
      ? [effective.defaultReasoningEffort]
      : (['medium'] as ReasoningEffortValue[]);

  const lines: string[] = [
    t(locale, 'weixin_copy_paste_divider'),
    t(locale, 'weixin_copy_models_title'),
    '/model default',
    ...models.map((m) => `/model ${m.model}`),
    '',
    t(locale, 'weixin_copy_efforts_title'),
    '/effort default',
    ...efforts.map((e) => `/effort ${e}`),
  ];
  return lines.join('\n');
}

export function formatWeixinAccessCopyPaste(locale: AppLocale): string {
  return [
    t(locale, 'weixin_copy_paste_divider'),
    t(locale, 'weixin_copy_access_title'),
    '/access read-only',
    '/access default',
    '/access full-access',
  ].join('\n');
}

export function formatWeixinWhereNavCopyPaste(locale: AppLocale, hasBinding: boolean): string {
  const lines = [
    t(locale, 'weixin_copy_paste_divider'),
    t(locale, 'weixin_copy_where_nav_title'),
    '/permissions',
    '/models',
    '/threads',
  ];
  if (hasBinding) {
    lines.push('/reveal');
  }
  return lines.join('\n');
}

export function formatModelSettingsMessage(
  locale: AppLocale,
  models: ModelInfo[],
  settings: ChatSessionSettings | null,
): string {
  const selectedModel = resolveCurrentModel(models, settings?.model ?? null);
  const selectedModelLabel = settings?.model ?? t(locale, 'server_default');
  const selectedEffort = settings?.reasoningEffort ?? null;
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
    t(locale, 'models_effort', { value: escapeTelegramHtml(selectedEffort ?? t(locale, 'server_default')) }),
    selectedModel ? t(locale, 'models_current_default_target', { value: escapeTelegramHtml(selectedModel.model) }) : null,
    supportedEfforts.length > 0
      ? t(locale, 'models_supported_efforts', { value: escapeTelegramHtml(supportedEfforts.join(', ')) })
      : t(locale, 'models_supported_efforts_unknown'),
  ].filter(Boolean).join('\n');
}

export function buildModelSettingsKeyboard(
  locale: AppLocale,
  models: ModelInfo[],
  settings: ChatSessionSettings | null,
): InlineButton[][] {
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

  return [
    ...chunkButtons(modelButtons, 2),
    ...chunkButtons(effortButtons, 3),
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
