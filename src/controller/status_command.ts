import { resolveEngineCapabilities, type EngineProvider } from '../engine/types.js';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { AccountIdentitySnapshot, AccountRateLimitSnapshot, AppLocale } from '../types.js';
import {
  formatAccessPresetLabel,
  formatApprovalPolicyLabel,
  formatBridgeEngineLabel,
  formatEngineModeLabel,
  formatSandboxModeLabel,
  formatServiceTierLabel,
} from './presentation.js';
import type { TelegramMessageService } from './telegram_message_service.js';

interface StatusCommandHost {
  store: BridgeStore;
  logger: Logger;
  app: EngineProvider;
  messages: TelegramMessageService;
  activeTurnCount: () => number;
  localeForChat: (scopeId: string) => AppLocale;
  resolveEffectiveAccess: (scopeId: string) => { preset: string; approvalPolicy: string; sandboxMode: string };
  lastError: () => string | null;
  updateStatus: () => void;
  config: {
    bridgeEngine: 'codex' | 'gemini' | 'claude';
    bridgeInstanceId: string | null;
    codexAppSyncOnOpen: boolean;
    codexAppSyncOnTurnComplete: boolean;
  };
}

export class StatusCommandCoordinator {
  constructor(private readonly host: StatusCommandHost) {}

  private get capabilities() {
    return resolveEngineCapabilities(this.host.app.capabilities);
  }

  async showStatus(scopeId: string, locale = this.host.localeForChat(scopeId)): Promise<void> {
    const binding = this.host.store.getBinding(scopeId);
    const settings = this.host.store.getChatSettings(scopeId);
    const access = this.host.resolveEffectiveAccess(scopeId);
    const accountIdentity = await this.readStatusAccountIdentity();
    const rateLimits = await this.readStatusRateLimits();
    const capabilities = this.capabilities;
    this.host.updateStatus();
    const lines = [
      t(locale, 'status_engine', { value: formatBridgeEngineLabel(locale, this.host.config.bridgeEngine) }),
      t(locale, 'status_instance', { value: this.host.config.bridgeInstanceId ?? t(locale, 'none') }),
      t(locale, 'status_connected', { value: t(locale, this.host.app.isConnected() ? 'yes' : 'no') }),
      accountIdentity
        ? t(locale, 'status_account_identity', { value: formatAccountIdentityLabel(accountIdentity) })
        : null,
      t(locale, 'status_last_error', { value: this.host.lastError() ?? t(locale, 'none') }),
      t(locale, 'status_user_agent', { value: this.host.app.getUserAgent() ?? t(locale, 'unknown') }),
      t(locale, 'status_current_thread', { value: binding?.threadId ?? t(locale, 'none') }),
      t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
      capabilities.reasoningEffort
        ? t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') })
        : null,
      capabilities.serviceTier
        ? t(locale, 'status_configured_service_tier', { value: formatServiceTierLabel(locale, settings?.serviceTier ?? null) })
        : null,
      (this.host.config.bridgeEngine === 'gemini' || capabilities.guidedPlan !== 'none')
        ? t(locale, 'status_mode', { value: formatEngineModeLabel(locale, this.host.config.bridgeEngine, settings) })
        : null,
      ...(capabilities.rateLimits ? formatRateLimitStatusLines(locale, rateLimits) : []),
      capabilities.guidedPlan !== 'none'
        ? t(locale, 'status_confirm_plan_before_execute', {
            value: t(locale, (settings?.confirmPlanBeforeExecute ?? true) ? 'yes' : 'no'),
          })
        : null,
      t(locale, 'status_auto_queue_messages', {
        value: t(locale, (settings?.autoQueueMessages ?? true) ? 'yes' : 'no'),
      }),
      capabilities.guidedPlan !== 'none'
        ? t(locale, 'status_persist_plan_history', {
            value: t(locale, (settings?.persistPlanHistory ?? true) ? 'yes' : 'no'),
          })
        : null,
      capabilities.approvals !== 'none'
        ? t(locale, 'status_access_preset', { value: formatAccessPresetLabel(locale, access.preset as any) })
        : null,
      capabilities.approvals !== 'none'
        ? t(locale, 'status_approval_policy', { value: formatApprovalPolicyLabel(locale, access.approvalPolicy as any) })
        : null,
      capabilities.approvals !== 'none'
        ? t(locale, 'status_sandbox_mode', { value: formatSandboxModeLabel(locale, access.sandboxMode as any) })
        : null,
      this.host.config.bridgeEngine === 'codex'
        ? t(locale, 'status_sync_on_open', { value: t(locale, this.host.config.codexAppSyncOnOpen ? 'yes' : 'no') })
        : null,
      this.host.config.bridgeEngine === 'codex'
        ? t(locale, 'status_sync_on_turn_complete', { value: t(locale, this.host.config.codexAppSyncOnTurnComplete ? 'yes' : 'no') })
        : null,
      t(locale, 'status_pending_approvals', { value: this.host.store.countPendingApprovals() }),
      t(locale, 'status_pending_user_inputs', { value: this.host.store.countPendingUserInputs() }),
      t(locale, 'status_pending_attachment_batches', { value: this.host.store.countPendingAttachmentBatches(scopeId) }),
      t(locale, 'status_queue_depth', { value: this.host.store.countQueuedTurnInputs(scopeId) }),
      t(locale, 'status_active_turns', { value: this.host.activeTurnCount() }),
    ].filter((line): line is string => Boolean(line));
    await this.host.messages.sendMessage(scopeId, lines.join('\n'));
  }

  private async readStatusRateLimits(): Promise<AccountRateLimitSnapshot | null> {
    if (!this.capabilities.rateLimits) {
      return null;
    }
    if (!this.host.app.isConnected()) {
      return typeof this.host.app.getAccountRateLimits === 'function' ? this.host.app.getAccountRateLimits() : null;
    }
    if (typeof this.host.app.readAccountRateLimits !== 'function') {
      return typeof this.host.app.getAccountRateLimits === 'function' ? this.host.app.getAccountRateLimits() : null;
    }
    try {
      return await this.host.app.readAccountRateLimits();
    } catch (error) {
      this.host.logger.warn('codex.account_rate_limits_status_failed', { error: String(error) });
      return typeof this.host.app.getAccountRateLimits === 'function' ? this.host.app.getAccountRateLimits() : null;
    }
  }

  private async readStatusAccountIdentity(): Promise<AccountIdentitySnapshot | null> {
    if (typeof this.host.app.readAccountIdentity === 'function') {
      try {
        return await this.host.app.readAccountIdentity();
      } catch (error) {
        this.host.logger.warn('codex.account_identity_status_failed', { error: String(error) });
      }
    }
    return typeof this.host.app.getAccountIdentity === 'function' ? this.host.app.getAccountIdentity() : null;
  }
}

export function formatRateLimitStatusLines(locale: AppLocale, snapshot: AccountRateLimitSnapshot | null): string[] {
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
    return locale === 'zh' ? '5小时' : locale === 'fr' ? '5 h' : '5h';
  }
  if (windowDurationMins === 10080) {
    return locale === 'zh' ? '本周' : locale === 'fr' ? 'hebdomadaire' : 'weekly';
  }
  if (windowDurationMins === null || !Number.isFinite(windowDurationMins) || windowDurationMins <= 0) {
    return t(locale, 'unknown');
  }
  if (windowDurationMins % 1440 === 0) {
    const days = Math.floor(windowDurationMins / 1440);
    return locale === 'zh' ? `${days}天` : locale === 'fr' ? `${days} j` : `${days}d`;
  }
  if (windowDurationMins % 60 === 0) {
    const hours = Math.floor(windowDurationMins / 60);
    return locale === 'zh' ? `${hours}小时` : locale === 'fr' ? `${hours} h` : `${hours}h`;
  }
  return locale === 'zh' ? `${windowDurationMins}分钟` : locale === 'fr' ? `${windowDurationMins} min` : `${windowDurationMins}m`;
}

function formatRateLimitResetAt(locale: AppLocale, resetsAt: number | null): string {
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return t(locale, 'unknown');
  }
  return new Date(resetsAt * 1000).toISOString();
}

function formatAccountIdentityLabel(snapshot: AccountIdentitySnapshot): string {
  const primary = snapshot.email ?? snapshot.name ?? snapshot.accountId ?? snapshot.authMode ?? 'unknown';
  const details = [snapshot.authMode, snapshot.accountId ? `id:${snapshot.accountId.slice(0, 8)}` : null]
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index) as string[];
  return details.length > 0 ? `${primary} (${details.join(', ')})` : primary;
}
