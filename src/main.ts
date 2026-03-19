import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { loadConfig, loadEnvFile, resolveBridgeRuntimePaths } from './config.js';
import { createEngineProvider } from './engine/factory.js';
import { Logger } from './logger.js';
import { BridgeStore } from './store/database.js';
import { TelegramGateway } from './telegram/gateway.js';
import { BridgeController } from './controller/controller.js';
import { acquireProcessLock, LockHeldError } from './lock.js';
import { detectPlatformCapabilities, getCommandLookupProgram, getDesktopOpenSupport } from './platform/capabilities.js';
import { spawnCommandSync } from './process/spawn_command.js';
import { readRuntimeStatus, writeRuntimeStatus } from './runtime.js';

const command = process.argv[2] || 'serve';
loadEnvFile();

async function main(): Promise<void> {
  if (command === 'status') {
    const status = readRuntimeStatus(resolveBridgeRuntimePaths().statusPath);
    if (!status) {
      console.log('No runtime status found.');
      process.exit(1);
    }
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (command === 'doctor') {
    const configuredEngine = resolveBridgeRuntimePaths().bridgeEngine;
    const configuredCodexBin = process.env.CODEX_CLI_BIN;
    const platform = detectPlatformCapabilities();
    const desktopOpen = getDesktopOpenSupport();
    const checks = [
      { name: `bridge engine configured: ${configuredEngine}`, ok: true, required: false },
      {
        name: configuredEngine === 'codex'
          ? 'codex engine runtime available'
          : 'gemini engine runtime available',
        ok: true,
        required: true,
      },
      { name: 'node >= 24', ok: Number(process.versions.node.split('.')[0]) >= 24, required: true },
      {
        name: 'codex cli available',
        ok: configuredEngine !== 'codex' || hasConfiguredCodexBin(configuredCodexBin) || hasCommand('codex'),
        required: configuredEngine === 'codex',
      },
      {
        name: 'gemini cli available',
        ok: configuredEngine !== 'gemini' || hasConfiguredGeminiBin(process.env.GEMINI_CLI_BIN) || hasCommand('gemini'),
        required: configuredEngine === 'gemini',
      },
      {
        name: 'codex app-server available',
        ok: configuredEngine !== 'codex' || hasCodexAppServer(configuredCodexBin),
        required: configuredEngine === 'codex',
      },
      { name: 'telegram bot token configured', ok: Boolean(process.env.TG_BOT_TOKEN), required: true },
      { name: 'telegram allowed user configured', ok: Boolean(process.env.TG_ALLOWED_USER_ID), required: true },
      { name: `platform detected: ${platform.os}, service manager: ${platform.serviceManager}`, ok: true, required: false },
      {
        name: desktopOpen.available
          ? `desktop open available via ${desktopOpen.command}`
          : `desktop open unavailable: ${desktopOpen.reason}`,
        ok: desktopOpen.available,
        required: false,
      },
    ];
    let failed = false;
    for (const check of checks) {
      const prefix = check.ok ? '[OK]' : check.required ? '[FAIL]' : '[WARN]';
      console.log(`${prefix} ${check.name}`);
      if (!check.ok && check.required) failed = true;
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

  const config = loadConfig();
  const logger = new Logger(config.logLevel, config.logPath);
  const processLock = acquireProcessLock(config.lockPath);
  let store: BridgeStore | null = null;
  try {
    store = new BridgeStore(config.storePath);
    const bot = new TelegramGateway(
      config.tgBotToken,
      config.tgAllowedUserId,
      config.tgAllowedChatId,
      config.telegramPollIntervalMs,
      store,
      logger,
      config.bridgeEngine,
      (config.platform?.restartMode ?? 'service') !== 'none',
    );
    const app = createEngineProvider(config, logger);
    const controller = new BridgeController(config, store, logger, bot, app);

    process.on('unhandledRejection', (error) => {
      logger.error('process.unhandled_rejection', { error: serializeError(error) });
    });

    process.on('uncaughtException', (error) => {
      logger.error('process.uncaught_exception', { error: serializeError(error) });
    });

    await controller.start();
    logger.info('bridge.started', controller.getRuntimeStatus());

    const shutdown = async (signal: string): Promise<void> => {
      logger.info('bridge.shutting_down', { signal });
      await controller.stop();
      writeRuntimeStatus(config.statusPath, {
        engine: config.bridgeEngine,
        instanceId: config.bridgeInstanceId,
        running: false,
        connected: false,
        userAgent: app.getUserAgent(),
        botUsername: bot.username,
        currentBindings: 0,
        pendingApprovals: 0,
        pendingUserInputs: 0,
        pendingAttachmentBatches: 0,
        queuedTurns: 0,
        activeTurns: 0,
        accountRateLimits: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
      });
      store?.close();
      processLock.release();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    store?.close();
    processLock.release();
    throw error;
  }
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
    const which = getCommandLookupProgram();
    const result = spawnSync(which, [commandName], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function hasConfiguredCodexBin(binPath: string | undefined): boolean {
  if (!binPath || !binPath.trim()) return false;
  try {
    fs.accessSync(binPath, executableAccessMode());
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredGeminiBin(binPath: string | undefined): boolean {
  if (!binPath || !binPath.trim()) return false;
  try {
    fs.accessSync(binPath, executableAccessMode());
    return true;
  } catch {
    return false;
  }
}

function executableAccessMode(): number {
  return process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
}

function hasCodexAppServer(configuredCodexBin: string | undefined): boolean {
  if (configuredCodexBin && hasConfiguredCodexBin(configuredCodexBin)) {
    try {
      const result = spawnCommandSync(configuredCodexBin, ['app-server', '--help'], { stdio: 'ignore' });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  if (!hasCommand('codex')) return false;
  try {
    const result = spawnCommandSync('codex', ['app-server', '--help'], { stdio: 'ignore' });
    return result.status === 0;
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
