import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import type { LogLevel } from './logger.js';
import { detectPlatformCapabilities, getCommandLookupProgram } from './platform/capabilities.js';
import type { ApprovalPolicyValue, SandboxModeValue } from './types.js';

export type BridgeEngineValue = 'codex' | 'gemini';

export const LEGACY_APP_HOME = path.join(os.homedir(), '.telegram-codex-app-bridge');
export const INSTANCES_APP_HOME = path.join(LEGACY_APP_HOME, 'instances');

export interface AppConfig {
  envFile: string;
  bridgeEngine: BridgeEngineValue;
  bridgeInstanceId: string | null;
  bridgeHome: string;
  tgBotToken: string;
  tgAllowedUserId: string;
  tgAllowedChatId: string | null;
  tgAllowedTopicId: number | null;
  codexCliBin: string;
  geminiCliBin: string;
  geminiDefaultModel: string | null;
  geminiModelAllowlist: string[];
  geminiIncludeDirectories: string[];
  geminiHeadlessTimeoutMs: number;
  codexAppAutolaunch: boolean;
  codexAppLaunchCmd: string;
  codexAppSyncOnOpen: boolean;
  codexAppSyncOnTurnComplete: boolean;
  storePath: string;
  logLevel: LogLevel;
  defaultCwd: string;
  defaultApprovalPolicy: ApprovalPolicyValue;
  defaultSandboxMode: SandboxModeValue;
  telegramPollIntervalMs: number;
  telegramPreviewThrottleMs: number;
  threadListLimit: number;
  statusPath: string;
  logPath: string;
  lockPath: string;
}

export function loadConfig(): AppConfig {
  const envFile = loadEnvFile();
  const platform = detectPlatformCapabilities();
  const runtimePaths = resolveBridgeRuntimePaths();
  const config: AppConfig = {
    envFile,
    bridgeEngine: runtimePaths.bridgeEngine,
    bridgeInstanceId: runtimePaths.bridgeInstanceId,
    bridgeHome: runtimePaths.bridgeHome,
    tgBotToken: required('TG_BOT_TOKEN'),
    tgAllowedUserId: required('TG_ALLOWED_USER_ID'),
    tgAllowedChatId: optional('TG_ALLOWED_CHAT_ID'),
    tgAllowedTopicId: nullableIntEnv('TG_ALLOWED_TOPIC_ID'),
    codexCliBin: process.env.CODEX_CLI_BIN || resolveCommand('codex') || 'codex',
    geminiCliBin: process.env.GEMINI_CLI_BIN || resolveCommand('gemini') || 'gemini',
    geminiDefaultModel: optional('GEMINI_DEFAULT_MODEL'),
    geminiModelAllowlist: listEnv('GEMINI_MODEL_ALLOWLIST'),
    geminiIncludeDirectories: listEnv('GEMINI_INCLUDE_DIRECTORIES'),
    geminiHeadlessTimeoutMs: intEnv('GEMINI_HEADLESS_TIMEOUT_MS', 15 * 60 * 1000),
    codexAppAutolaunch: boolEnv('CODEX_APP_AUTOLAUNCH', platform.os === 'darwin'),
    codexAppLaunchCmd: process.env.CODEX_APP_LAUNCH_CMD || '',
    codexAppSyncOnOpen: boolEnv('CODEX_APP_SYNC_ON_OPEN', true),
    codexAppSyncOnTurnComplete: boolEnv('CODEX_APP_SYNC_ON_TURN_COMPLETE', false),
    storePath: runtimePaths.storePath,
    logLevel: parseLogLevel(process.env.LOG_LEVEL || 'info'),
    defaultCwd: process.env.DEFAULT_CWD || process.cwd(),
    defaultApprovalPolicy: parseApprovalPolicy(process.env.DEFAULT_APPROVAL_POLICY || 'on-request'),
    defaultSandboxMode: parseSandboxMode(process.env.DEFAULT_SANDBOX_MODE || 'workspace-write'),
    telegramPollIntervalMs: intEnv('TELEGRAM_POLL_INTERVAL_MS', 1200),
    telegramPreviewThrottleMs: intEnv('TELEGRAM_PREVIEW_THROTTLE_MS', 800),
    threadListLimit: intEnv('THREAD_LIST_LIMIT', 10),
    statusPath: runtimePaths.statusPath,
    logPath: runtimePaths.logPath,
    lockPath: runtimePaths.lockPath,
  };
  ensureAppDirs(config);
  return config;
}

export function ensureAppDirs(config: AppConfig): void {
  const dirs = [
    path.dirname(config.storePath),
    path.dirname(config.statusPath),
    path.dirname(config.logPath),
    path.dirname(config.lockPath),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadEnvFile(env = process.env, cwd = process.cwd()): string {
  const envFile = resolveEnvFilePath(env, cwd);
  dotenv.config({ path: envFile });
  return envFile;
}

export function resolveEnvFilePath(env = process.env, cwd = process.cwd()): string {
  const raw = env.ENV_FILE?.trim();
  if (!raw) {
    return path.join(cwd, '.env');
  }
  return path.resolve(raw);
}

export interface BridgeRuntimePaths {
  bridgeEngine: BridgeEngineValue;
  bridgeInstanceId: string | null;
  bridgeHome: string;
  storePath: string;
  statusPath: string;
  logPath: string;
  lockPath: string;
}

export function resolveBridgeRuntimePaths(
  env = process.env,
  homeDir = os.homedir(),
): BridgeRuntimePaths {
  const bridgeEngine = resolveBridgeEngine(env.BRIDGE_ENGINE);
  const bridgeInstanceId = resolveBridgeInstanceId(env.BRIDGE_INSTANCE_ID, bridgeEngine);
  const bridgeHome = resolveBridgeHome({
    explicitHome: env.BRIDGE_HOME,
    legacyHome: env.APP_HOME,
    bridgeInstanceId,
    homeDir,
  });
  return {
    bridgeEngine,
    bridgeInstanceId,
    bridgeHome,
    storePath: env.STORE_PATH || getDefaultStorePath(bridgeHome),
    statusPath: env.STATUS_PATH || getDefaultStatusPath(bridgeHome),
    logPath: env.LOG_PATH || getDefaultLogPath(bridgeHome),
    lockPath: env.LOCK_PATH || getDefaultLockPath(bridgeHome),
  };
}

export function resolveBridgeEngine(rawValue: string | null | undefined): BridgeEngineValue {
  return rawValue?.trim().toLowerCase() === 'gemini' ? 'gemini' : 'codex';
}

export function resolveBridgeInstanceId(
  rawValue: string | null | undefined,
  bridgeEngine: BridgeEngineValue,
): string | null {
  const sanitized = sanitizeInstanceId(rawValue);
  if (sanitized) {
    return sanitized;
  }
  return bridgeEngine === 'codex' ? null : bridgeEngine;
}

export function resolveBridgeHome(options: {
  explicitHome?: string | null | undefined;
  legacyHome?: string | null | undefined;
  bridgeInstanceId: string | null;
  homeDir?: string;
}): string {
  const homeDir = options.homeDir ?? os.homedir();
  const explicit = options.explicitHome?.trim() || options.legacyHome?.trim() || null;
  if (explicit) {
    return path.resolve(explicit);
  }
  if (options.bridgeInstanceId) {
    return path.join(homeDir, '.telegram-codex-app-bridge', 'instances', options.bridgeInstanceId);
  }
  return path.join(homeDir, '.telegram-codex-app-bridge');
}

export function getDefaultStorePath(bridgeHome: string): string {
  return path.join(bridgeHome, 'data', 'bridge.sqlite');
}

export function getDefaultStatusPath(bridgeHome: string): string {
  return path.join(bridgeHome, 'runtime', 'status.json');
}

export function getDefaultLogPath(bridgeHome: string): string {
  return path.join(bridgeHome, 'logs', 'service.log');
}

export function getDefaultLockPath(bridgeHome: string): string {
  return path.join(bridgeHome, 'runtime', 'bridge.lock');
}

function required(key: string): string {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optional(key: string): string | null {
  const value = process.env[key];
  if (!value || !value.trim()) return null;
  return value.trim();
}

function intEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableIntEnv(key: string): number | null {
  const value = process.env[key];
  if (!value || !value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (!value) return fallback;
  return value !== 'false' && value !== '0';
}

function listEnv(key: string): string[] {
  const value = process.env[key];
  if (!value || !value.trim()) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseLogLevel(value: string): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return 'info';
}

function parseApprovalPolicy(value: string): AppConfig['defaultApprovalPolicy'] {
  if (value === 'on-failure' || value === 'never' || value === 'untrusted' || value === 'on-request') return value;
  return 'on-request';
}

function parseSandboxMode(value: string): AppConfig['defaultSandboxMode'] {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value;
  return 'workspace-write';
}

function sanitizeInstanceId(rawValue: string | null | undefined): string | null {
  if (!rawValue || !rawValue.trim()) {
    return null;
  }
  const sanitized = rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || null;
}

function resolveCommand(commandName: string): string | null {
  try {
    const which = getCommandLookupProgram();
    const result = spawnSync(which, [commandName], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    return String(result.stdout).trim().split(/\r?\n/, 1)[0] || null;
  } catch {
    return null;
  }
}
