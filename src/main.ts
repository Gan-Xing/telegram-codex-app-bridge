import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { APP_HOME, DEFAULT_LOG_PATH, DEFAULT_STATUS_PATH, loadConfig } from './config.js';
import { BridgeMessagingRouter } from './channels/bridge_messaging_router.js';
import { TelegramMessagingPort } from './channels/telegram/telegram_messaging_port.js';
import { WeixinChannelAdapter } from './channels/weixin/weixin_channel_adapter.js';
import { WeixinMessagingPort } from './channels/weixin/weixin_messaging_port.js';
import { attachIlinkRuntimeFromBridgeLogger } from './channels/weixin/ilink/runtime_attach.js';
import { startWeixinLoginWithQr, waitForWeixinLogin } from './channels/weixin/ilink/login_qr.js';
import { accountFilePath, loadWeixinAccount, saveWeixinAccount } from './channels/weixin/account_store.js';
import { Logger, type LogLevel } from './logger.js';
import { BridgeStore } from './store/database.js';
import { TelegramGateway } from './telegram/gateway.js';
import { CodexAppClient } from './codex_app/client.js';
import { BridgeSessionCore } from './controller/controller.js';
import { TelegramChannelAdapter } from './channels/telegram/telegram_channel_adapter.js';
import { acquireProcessLock, LockHeldError } from './lock.js';
import { readRuntimeStatus, writeRuntimeStatus } from './runtime.js';

const command = process.argv[2] || 'serve';
dotenv.config();

async function main(): Promise<void> {
  if (command === 'status') {
    const status = readRuntimeStatus(process.env.STATUS_PATH || DEFAULT_STATUS_PATH);
    if (!status) {
      console.log('No runtime status found.');
      process.exit(1);
    }
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (command === 'doctor') {
    const configuredCodexBin = process.env.CODEX_CLI_BIN;
    const checks: Array<[string, boolean]> = [
      ['node >= 24', Number(process.versions.node.split('.')[0]) >= 24],
      ['codex cli available', hasConfiguredCodexBin(configuredCodexBin) || hasCommand('codex')],
      ['telegram bot token configured', Boolean(process.env.TG_BOT_TOKEN)],
      ['telegram allowed user configured', Boolean(process.env.TG_ALLOWED_USER_ID)],
    ];
    if (process.env.WX_ENABLED === 'true' || process.env.WX_ENABLED === '1') {
      const accountsDir = process.env.WEIXIN_ACCOUNTS_DIR || path.join(APP_HOME, 'weixin', 'accounts');
      let hasAccounts = false;
      try {
        if (fs.existsSync(accountsDir)) {
          hasAccounts = fs.readdirSync(accountsDir).some((n) => n.endsWith('.json'));
        }
      } catch {
        hasAccounts = false;
      }
      checks.push(['WX_ENABLED: Weixin account JSON present', hasAccounts]);
      checks.push(['WX_ALLOWED_ILINK_USER_IDS set (recommended)', Boolean(process.env.WX_ALLOWED_ILINK_USER_IDS?.trim())]);
    }
    let failed = false;
    for (const [name, ok] of checks) {
      console.log(`${ok ? '[OK]' : '[FAIL]'} ${name}`);
      if (!ok) failed = true;
    }
    try {
      const cwd = process.env.DEFAULT_CWD || process.cwd();
      fs.accessSync(cwd);
      console.log(`[OK] default cwd exists: ${cwd}`);
    } catch {
      const cwd = process.env.DEFAULT_CWD || process.cwd();
      console.log(`[FAIL] default cwd missing: ${cwd}`);
      failed = true;
    }
    process.exit(failed ? 1 : 0);
  }

  if (command === 'weixin-login') {
    await runWeixinLoginCli();
    return;
  }

  const config = loadConfig();
  const logger = new Logger(config.logLevel, config.logPath);
  attachIlinkRuntimeFromBridgeLogger(logger, config.wxIlinkRouteTag);
  const processLock = acquireProcessLock(config.lockPath);
  let store: BridgeStore | null = null;
  let weixinAdapter: WeixinChannelAdapter | null = null;
  try {
    store = new BridgeStore(config.storePath);
    const bot = new TelegramGateway(
      config.tgBotToken,
      config.tgAllowedUserId,
      config.tgAllowedChatId,
      config.telegramPollIntervalMs,
      store,
      logger,
    );
    const app = new CodexAppClient(
      config.codexCliBin,
      config.codexAppLaunchCmd,
      config.codexAppAutolaunch,
      logger,
    );
    const telegramMessaging = new TelegramMessagingPort(bot);
    const weixinMessaging = config.wxEnabled
      ? new WeixinMessagingPort(store, (id) => loadWeixinAccount(config.weixinAccountsDir, id))
      : null;
    const outbound = new BridgeMessagingRouter(telegramMessaging, weixinMessaging);
    const core = new BridgeSessionCore(config, store, logger, bot, app, outbound);
    const telegram = new TelegramChannelAdapter(core);
    if (config.wxEnabled) {
      weixinAdapter = new WeixinChannelAdapter(core, store, config, logger);
    }

    process.on('unhandledRejection', (error) => {
      logger.error('process.unhandled_rejection', { error: serializeError(error) });
    });

    process.on('uncaughtException', (error) => {
      logger.error('process.uncaught_exception', { error: serializeError(error) });
    });

    await telegram.start();
    if (weixinAdapter) {
      await weixinAdapter.start();
    }
    logger.info('bridge.started', core.getRuntimeStatus());

    const shutdown = async (signal: string): Promise<void> => {
      logger.info('bridge.shutting_down', { signal });
      await weixinAdapter?.stop();
      await telegram.stop();
      writeRuntimeStatus(config.statusPath, {
        running: false,
        connected: false,
        userAgent: app.getUserAgent(),
        botUsername: bot.username,
        currentBindings: 0,
        pendingApprovals: 0,
        activeTurns: 0,
        lastError: null,
        updatedAt: new Date().toISOString(),
        channels: { telegram: false, weixin: false },
      });
      store?.close();
      processLock.release();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    await weixinAdapter?.stop().catch(() => {});
    store?.close();
    processLock.release();
    throw error;
  }
}

async function runWeixinLoginCli(): Promise<void> {
  const logPath = process.env.LOG_PATH || DEFAULT_LOG_PATH;
  const level: LogLevel =
    process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'warn' || process.env.LOG_LEVEL === 'error'
      ? process.env.LOG_LEVEL
      : 'info';
  const logger = new Logger(level, logPath);
  attachIlinkRuntimeFromBridgeLogger(logger, process.env.WX_ILINK_ROUTE_TAG ?? null);
  const accountsDir = process.env.WEIXIN_ACCOUNTS_DIR || path.join(APP_HOME, 'weixin', 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true });
  const accountHint = process.argv.slice(3).find((a) => !a.startsWith('-'))?.trim();
  const start = await startWeixinLoginWithQr({
    apiBaseUrl: 'https://ilinkai.weixin.qq.com',
    force: process.env.WX_LOGIN_FORCE === '1' || process.env.WX_LOGIN_FORCE === 'true',
    ...(accountHint ? { accountId: accountHint } : {}),
  });
  if (!start.qrcodeUrl) {
    console.error(start.message);
    process.exit(1);
  }
  console.log(start.message);
  try {
    const qrterm = await import('qrcode-terminal');
    qrterm.default.generate(start.qrcodeUrl, { small: true });
  } catch {
    console.log('Open this URL in a browser to scan:', start.qrcodeUrl);
  }
  const wait = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: 'https://ilinkai.weixin.qq.com',
    verbose: process.env.WX_LOGIN_VERBOSE === '1',
    notify: (s) => process.stdout.write(s),
    onQrRefreshed: async (url: string) => {
      try {
        const qrterm = await import('qrcode-terminal');
        qrterm.default.generate(url, { small: true });
        process.stdout.write(`If the QR did not render, open:\n${url}\n`);
      } catch {
        process.stdout.write(`Open this URL to scan:\n${url}\n`);
      }
    },
  });
  if (!wait.connected || !wait.accountId || !wait.botToken) {
    console.error(wait.message);
    process.exit(1);
  }
  let baseUrl = wait.baseUrl?.trim() || 'https://ilink.weixin.qq.com';
  if (!/^https?:\/\//i.test(baseUrl)) {
    baseUrl = `https://${baseUrl}`;
  }
  saveWeixinAccount(accountsDir, {
    accountId: wait.accountId,
    botToken: wait.botToken,
    baseUrl,
    savedAt: Date.now(),
    ...(wait.userId !== undefined ? { linkedIlinkUserId: wait.userId } : {}),
  });
  console.log(`${wait.message} Account saved to ${accountFilePath(accountsDir, wait.accountId)}`);
}

void main().catch((error) => {
  if (error instanceof LockHeldError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

function hasCommand(commandName: string): boolean {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(which, [commandName], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function hasConfiguredCodexBin(binPath: string | undefined): boolean {
  if (!binPath || !binPath.trim()) return false;
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
