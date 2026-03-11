import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import type { LogLevel } from './logger.js';
import { detectPlatformCapabilities, getCommandLookupProgram } from './platform/capabilities.js';
import type { ApprovalPolicyValue, SandboxModeValue } from './types.js';

export const APP_HOME = path.join(os.homedir(), '.telegram-codex-app-bridge');
export const DEFAULT_STORE_PATH = path.join(APP_HOME, 'data', 'bridge.sqlite');
export const DEFAULT_STATUS_PATH = path.join(APP_HOME, 'runtime', 'status.json');
export const DEFAULT_LOG_PATH = path.join(APP_HOME, 'logs', 'service.log');
export const DEFAULT_LOCK_PATH = path.join(APP_HOME, 'runtime', 'bridge.lock');

export interface AppConfig {
  tgBotToken: string;
  tgAllowedUserId: string;
  tgAllowedChatId: string | null;
  tgAllowedTopicId: number | null;
  codexCliBin: string;
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
  dotenv.config();
  const platform = detectPlatformCapabilities();
  const config: AppConfig = {
    tgBotToken: required('TG_BOT_TOKEN'),
    tgAllowedUserId: required('TG_ALLOWED_USER_ID'),
    tgAllowedChatId: optional('TG_ALLOWED_CHAT_ID'),
    tgAllowedTopicId: nullableIntEnv('TG_ALLOWED_TOPIC_ID'),
    codexCliBin: process.env.CODEX_CLI_BIN || resolveCommand('codex') || 'codex',
    codexAppAutolaunch: boolEnv('CODEX_APP_AUTOLAUNCH', platform.os === 'darwin'),
    codexAppLaunchCmd: process.env.CODEX_APP_LAUNCH_CMD || '',
    codexAppSyncOnOpen: boolEnv('CODEX_APP_SYNC_ON_OPEN', true),
    codexAppSyncOnTurnComplete: boolEnv('CODEX_APP_SYNC_ON_TURN_COMPLETE', false),
    storePath: process.env.STORE_PATH || DEFAULT_STORE_PATH,
    logLevel: parseLogLevel(process.env.LOG_LEVEL || 'info'),
    defaultCwd: process.env.DEFAULT_CWD || process.cwd(),
    defaultApprovalPolicy: parseApprovalPolicy(process.env.DEFAULT_APPROVAL_POLICY || 'on-request'),
    defaultSandboxMode: parseSandboxMode(process.env.DEFAULT_SANDBOX_MODE || 'workspace-write'),
    telegramPollIntervalMs: intEnv('TELEGRAM_POLL_INTERVAL_MS', 1200),
    telegramPreviewThrottleMs: intEnv('TELEGRAM_PREVIEW_THROTTLE_MS', 800),
    threadListLimit: intEnv('THREAD_LIST_LIMIT', 10),
    statusPath: DEFAULT_STATUS_PATH,
    logPath: DEFAULT_LOG_PATH,
    lockPath: process.env.LOCK_PATH || DEFAULT_LOCK_PATH,
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
