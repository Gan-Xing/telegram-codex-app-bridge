import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { EngineProvider } from '../engine/types.js';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { RestartMode } from '../platform/capabilities.js';
import { getServiceRestartScriptCommand } from '../platform/service_scripts.js';
import type { AccountIdentitySnapshot, AccountRateLimitSnapshot, AppLocale } from '../types.js';
import type { RuntimeStatusStore } from './bridge_runtime.js';
import { formatRateLimitStatusLines } from './status_command.js';
import type { TelegramMessageService } from './telegram_message_service.js';
import { formatUserError } from './utils.js';

const CONTROLLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(CONTROLLER_DIR, '../..');

interface ServiceControlHost {
  logger: Logger;
  restartMode: RestartMode;
  app: Pick<EngineProvider, 'isConnected' | 'start' | 'stop'>
    & Partial<Pick<EngineProvider, 'getAccountIdentity' | 'readAccountIdentity' | 'getAccountRateLimits' | 'readAccountRateLimits'>>;
  messages: TelegramMessageService;
  localeForChat: (scopeId: string) => AppLocale;
  activeTurnCount: () => number;
  runtimeStatus: Pick<RuntimeStatusStore, 'clearLastError' | 'setLastError' | 'getLastError'>;
  updateStatus: () => void;
  restartBridge?: () => Promise<void>;
  spawnRestartScript?: (scopeId: string, locale: AppLocale) => Promise<void>;
}

export class ServiceControlCoordinator {
  constructor(private readonly host: ServiceControlHost) {}

  async reconnect(scopeId: string, locale = this.host.localeForChat(scopeId)): Promise<void> {
    if (!await this.ensureMaintenanceAllowed(scopeId, locale)) {
      return;
    }
    await this.host.messages.sendMessage(scopeId, t(locale, 'reconnect_started'));
    try {
      await this.host.app.stop();
      this.host.updateStatus();
      await this.host.app.start();
      let accountIdentity: AccountIdentitySnapshot | null = null;
      if (typeof this.host.app.readAccountIdentity === 'function') {
        try {
          accountIdentity = await this.host.app.readAccountIdentity();
        } catch (error) {
          this.host.logger.warn('codex.reconnect_account_identity_failed', { error: String(error) });
        }
      }
      let rateLimits: AccountRateLimitSnapshot | null = null;
      if (typeof this.host.app.readAccountRateLimits === 'function') {
        try {
          rateLimits = await this.host.app.readAccountRateLimits();
        } catch (error) {
          this.host.logger.warn('codex.reconnect_rate_limits_failed', { error: String(error) });
        }
      }
      this.host.runtimeStatus.clearLastError();
      this.host.updateStatus();
      const lines = [
        t(locale, 'reconnect_succeeded'),
        t(locale, 'status_connected', { value: t(locale, this.host.app.isConnected() ? 'yes' : 'no') }),
        ...(accountIdentity
          ? [t(locale, 'status_account_identity', { value: formatAccountIdentityLabel(accountIdentity) })]
          : []),
        ...(rateLimits ? formatRateLimitStatusLines(locale, rateLimits) : [t(locale, 'reconnect_rate_limits_unavailable')]),
      ];
      await this.host.messages.sendMessage(scopeId, lines.join('\n'));
    } catch (error) {
      this.host.runtimeStatus.setLastError(error);
      this.host.updateStatus();
      await this.host.messages.sendMessage(scopeId, t(locale, 'reconnect_failed', { error: formatUserError(error) }));
    }
  }

  async restart(scopeId: string, locale = this.host.localeForChat(scopeId)): Promise<void> {
    if (!await this.ensureMaintenanceAllowed(scopeId, locale)) {
      return;
    }
    try {
      if (this.host.restartMode === 'in-process') {
        if (!this.host.restartBridge) {
          throw new Error('in-process restart is unavailable');
        }
        await this.host.restartBridge();
        this.host.runtimeStatus.clearLastError();
        this.host.updateStatus();
        await this.host.messages.sendMessage(scopeId, t(locale, 'restart_completed'));
        return;
      }
      if (this.host.restartMode === 'none') {
        await this.host.messages.sendMessage(scopeId, t(locale, 'restart_not_supported'));
        return;
      }
      if (this.host.spawnRestartScript) {
        await this.host.spawnRestartScript(scopeId, locale);
      } else {
        spawnRestartScript(scopeId, locale);
      }
      await this.host.messages.sendMessage(scopeId, t(locale, 'restart_requested'));
    } catch (error) {
      this.host.runtimeStatus.setLastError(error);
      this.host.updateStatus();
      await this.host.messages.sendMessage(scopeId, t(locale, 'restart_failed', { error: formatUserError(error) }));
    }
  }

  private async ensureMaintenanceAllowed(scopeId: string, locale: AppLocale): Promise<boolean> {
    if (this.host.activeTurnCount() > 0) {
      await this.host.messages.sendMessage(scopeId, t(locale, 'maintenance_active_turn_blocked'));
      return false;
    }
    return true;
  }
}

function formatAccountIdentityLabel(snapshot: AccountIdentitySnapshot): string {
  const primary = snapshot.email ?? snapshot.name ?? snapshot.accountId ?? snapshot.authMode ?? 'unknown';
  const details = [snapshot.authMode, snapshot.accountId ? `id:${snapshot.accountId.slice(0, 8)}` : null]
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index) as string[];
  return details.length > 0 ? `${primary} (${details.join(', ')})` : primary;
}

function spawnRestartScript(scopeId: string, locale: AppLocale): void {
  const restartScript = getServiceRestartScriptCommand();
  const child = spawn(restartScript.command, restartScript.args, {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      NOTIFY_SCOPE_ID: scopeId,
      NOTIFY_LOCALE: locale,
    },
  });
  child.unref();
}
