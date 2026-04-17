import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import type { LogLevel } from './logger.js';
import { detectPlatformCapabilities, getCommandLookupProgram, type PlatformCapabilities } from './platform/capabilities.js';
import type { ApprovalPolicyValue, ModelInfo, ReasoningEffortValue, SandboxModeValue } from './types.js';

export type BridgeEngineValue = 'codex' | 'gemini' | 'claude' | 'opencode';

export const LEGACY_APP_HOME = path.join(os.homedir(), '.telegram-codex-app-bridge');
export const INSTANCES_APP_HOME = path.join(LEGACY_APP_HOME, 'instances');

export interface CodexProviderProfileConfig {
  id: string;
  displayName: string;
  cliBin: string;
  modelCatalogPath: string | null;
  modelCatalog: ModelInfo[];
  defaultModel: string | null;
  providerLabel?: string | null;
  backendBaseUrl?: string | null;
  modelCatalogMode?: 'merge' | 'overlay-only';
  capabilities?: {
    reasoningEffort?: boolean;
    serviceTier?: boolean;
  } | null;
}

export interface AppConfig {
  envFile: string;
  platform?: PlatformCapabilities;
  bridgeEngine: BridgeEngineValue;
  bridgeInstanceId: string | null;
  bridgeHome: string;
  tgBotToken: string;
  tgAllowedUserId: string;
  tgAllowedChatId: string | null;
  tgAllowedTopicId: number | null;
  codexCliBin: string;
  codexModelCatalogPath?: string | null;
  codexModelCatalog?: ModelInfo[];
  codexProviderProfiles: CodexProviderProfileConfig[];
  codexDefaultProviderProfileId: string;
  geminiCliBin: string;
  claudeCliBin?: string;
  opencodeCliBin?: string;
  geminiDefaultModel: string | null;
  geminiModelAllowlist: string[];
  geminiIncludeDirectories: string[];
  geminiHeadlessTimeoutMs: number;
  claudeDefaultModel?: string | null;
  claudeModelAllowlist?: string[];
  claudeIncludeDirectories?: string[];
  claudeAllowedTools?: string[];
  claudePermissionMode?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'plan';
  claudeHeadlessTimeoutMs?: number;
  opencodeDefaultModel?: string | null;
  opencodeDefaultAgent?: string | null;
  opencodeServerHostname?: string | null;
  opencodeServerPort?: number | null;
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
  const requestedDefaultProviderId = optional('CODEX_DEFAULT_PROVIDER_PROFILE_ID');
  const codexProviderProfiles = loadCodexProviderProfiles({
    codexRealBin: process.env.CODEX_REAL_BIN || resolveCommand('codex') || 'codex',
    codexProxyBin: process.env.CODEX_CLI_BIN || resolveCommand('codex') || 'codex',
    codexProxyModelCatalogPath: optional('CODEX_MODEL_CATALOG_PATH'),
    codexProxyDefaultModel: optional('CODEX_PROVIDER_DEFAULT_MODEL') ?? 'MiniMax-M2.7',
    codexProxyDisplayName: optional('CODEX_PROVIDER_NAME') ?? 'CLIProxyAPI MiniMax',
    codexProxyProviderLabel: optional('CODEX_PROVIDER_ID') ?? 'cliproxyminimax',
    codexProxyBaseUrl: optional('CODEX_PROVIDER_BASE_URL'),
    defaultProviderId: requestedDefaultProviderId,
  });
  const codexDefaultProviderProfileId = codexProviderProfiles.some((profile) => profile.id === (requestedDefaultProviderId ?? ''))
    ? String(requestedDefaultProviderId!)
    : codexProviderProfiles[0]?.id ?? 'openai-native';
  const defaultCodexProfile = codexProviderProfiles.find((profile) => profile.id === codexDefaultProviderProfileId)
    ?? codexProviderProfiles[0]
    ?? null;
  const config: AppConfig = {
    envFile,
    platform,
    bridgeEngine: runtimePaths.bridgeEngine,
    bridgeInstanceId: runtimePaths.bridgeInstanceId,
    bridgeHome: runtimePaths.bridgeHome,
    tgBotToken: required('TG_BOT_TOKEN'),
    tgAllowedUserId: required('TG_ALLOWED_USER_ID'),
    tgAllowedChatId: optional('TG_ALLOWED_CHAT_ID'),
    tgAllowedTopicId: nullableIntEnv('TG_ALLOWED_TOPIC_ID'),
    codexCliBin: defaultCodexProfile?.cliBin ?? (process.env.CODEX_CLI_BIN || resolveCommand('codex') || 'codex'),
    codexModelCatalogPath: defaultCodexProfile?.modelCatalogPath ?? optional('CODEX_MODEL_CATALOG_PATH'),
    codexModelCatalog: defaultCodexProfile?.modelCatalog ?? loadCodexModelCatalog(optional('CODEX_MODEL_CATALOG_PATH')),
    codexProviderProfiles,
    codexDefaultProviderProfileId,
    geminiCliBin: process.env.GEMINI_CLI_BIN || resolveCommand('gemini') || 'gemini',
    claudeCliBin: process.env.CLAUDE_CLI_BIN || resolveCommand('claude') || 'claude',
    opencodeCliBin: process.env.OPENCODE_CLI_BIN || resolveCommand('opencode') || 'opencode',
    geminiDefaultModel: optional('GEMINI_DEFAULT_MODEL'),
    geminiModelAllowlist: listEnv('GEMINI_MODEL_ALLOWLIST'),
    geminiIncludeDirectories: listEnv('GEMINI_INCLUDE_DIRECTORIES'),
    geminiHeadlessTimeoutMs: intEnv('GEMINI_HEADLESS_TIMEOUT_MS', 15 * 60 * 1000),
    claudeDefaultModel: optional('CLAUDE_DEFAULT_MODEL'),
    claudeModelAllowlist: listEnv('CLAUDE_MODEL_ALLOWLIST'),
    claudeIncludeDirectories: listEnv('CLAUDE_INCLUDE_DIRECTORIES'),
    claudeAllowedTools: listEnv('CLAUDE_ALLOWED_TOOLS'),
    claudePermissionMode: parseClaudePermissionMode(process.env.CLAUDE_PERMISSION_MODE || 'default'),
    claudeHeadlessTimeoutMs: intEnv('CLAUDE_HEADLESS_TIMEOUT_MS', 15 * 60 * 1000),
    opencodeDefaultModel: optional('OPENCODE_DEFAULT_MODEL'),
    opencodeDefaultAgent: optional('OPENCODE_DEFAULT_AGENT'),
    opencodeServerHostname: optional('OPENCODE_SERVER_HOSTNAME') ?? '127.0.0.1',
    opencodeServerPort: nullableIntEnv('OPENCODE_SERVER_PORT'),
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

export function loadCodexProviderProfiles(options: {
  codexRealBin: string;
  codexProxyBin: string;
  codexProxyModelCatalogPath: string | null;
  codexProxyDefaultModel: string | null;
  codexProxyDisplayName: string;
  codexProxyProviderLabel: string;
  codexProxyBaseUrl: string | null;
  defaultProviderId: string | null;
}): CodexProviderProfileConfig[] {
  const openaiProfile: CodexProviderProfileConfig = {
    id: 'openai-native',
    displayName: 'OpenAI Codex',
    cliBin: options.codexRealBin,
    modelCatalogPath: null,
    modelCatalog: [],
    defaultModel: null,
    providerLabel: 'openai',
    backendBaseUrl: null,
    modelCatalogMode: 'merge',
    capabilities: {
      reasoningEffort: true,
      serviceTier: true,
    },
  };
  const proxyProfile: CodexProviderProfileConfig = {
    id: 'cliproxyminimax',
    displayName: options.codexProxyDisplayName,
    cliBin: options.codexProxyBin,
    modelCatalogPath: options.codexProxyModelCatalogPath,
    modelCatalog: loadCodexModelCatalog(options.codexProxyModelCatalogPath),
    defaultModel: options.codexProxyDefaultModel,
    providerLabel: options.codexProxyProviderLabel,
    backendBaseUrl: options.codexProxyBaseUrl,
    modelCatalogMode: 'overlay-only',
    capabilities: {
      reasoningEffort: true,
      serviceTier: false,
    },
  };
  const preferredId = options.defaultProviderId?.trim().toLowerCase();
  const defaultProfileId = preferredId === 'openai-native'
    ? openaiProfile.id
    : preferredId === 'cliproxyminimax'
      ? proxyProfile.id
      : openaiProfile.id;
  return defaultProfileId === proxyProfile.id
    ? [proxyProfile, openaiProfile]
    : [openaiProfile, proxyProfile];
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
  const normalized = rawValue?.trim().toLowerCase();
  if (normalized === 'gemini') {
    return 'gemini';
  }
  if (normalized === 'claude') {
    return 'claude';
  }
  if (normalized === 'opencode') {
    return 'opencode';
  }
  return 'codex';
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

function loadCodexModelCatalog(catalogPath: string | null): ModelInfo[] {
  if (!catalogPath) {
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(catalogPath), 'utf8')) as unknown;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map(parseCodexCatalogEntry)
      .filter((entry): entry is ModelInfo => entry !== null);
  } catch {
    return [];
  }
}

function parseCodexCatalogEntry(value: unknown): ModelInfo | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const model = typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : null;
  if (!model) {
    return null;
  }
  const supportedReasoningEfforts = parseReasoningEffortList(entry.supportedReasoningEfforts);
  const defaultReasoningEffort = parseReasoningEffort(entry.defaultReasoningEffort)
    ?? supportedReasoningEfforts[0]
    ?? 'none';
  const supportedVariants = Array.isArray(entry.supportedVariants)
    ? entry.supportedVariants
      .map((variant) => typeof variant === 'string' ? variant.trim() : '')
      .filter(Boolean)
    : undefined;
  const variantReasoningEfforts = entry.variantReasoningEfforts && typeof entry.variantReasoningEfforts === 'object'
    ? Object.fromEntries(
        Object.entries(entry.variantReasoningEfforts as Record<string, unknown>)
          .map(([variant, effort]) => {
            const normalizedVariant = variant.trim();
            if (!normalizedVariant) {
              return null;
            }
            return [normalizedVariant, parseReasoningEffort(effort)] as const;
          })
          .filter((pair): pair is readonly [string, ReasoningEffortValue | null] => pair !== null),
      )
    : undefined;
  const parsed: ModelInfo = {
    id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : model,
    model,
    displayName: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : model,
    description: typeof entry.description === 'string' ? entry.description : '',
    isDefault: Boolean(entry.isDefault),
    supportedReasoningEfforts,
    defaultReasoningEffort,
  };
  if (supportedVariants && supportedVariants.length > 0) {
    parsed.supportedVariants = supportedVariants;
  }
  if (variantReasoningEfforts && Object.keys(variantReasoningEfforts).length > 0) {
    parsed.variantReasoningEfforts = variantReasoningEfforts;
  }
  return parsed;
}

function parseReasoningEffortList(value: unknown): ReasoningEffortValue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const efforts: ReasoningEffortValue[] = [];
  const seen = new Set<ReasoningEffortValue>();
  for (const entry of value) {
    const normalized = parseReasoningEffort(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    efforts.push(normalized);
  }
  return efforts;
}

function parseReasoningEffort(value: unknown): ReasoningEffortValue | null {
  if (typeof value !== 'string') {
    return null;
  }
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

function parseClaudePermissionMode(value: string): NonNullable<AppConfig['claudePermissionMode']> {
  if (value === 'default'
    || value === 'acceptEdits'
    || value === 'auto'
    || value === 'bypassPermissions'
    || value === 'dontAsk'
    || value === 'plan') {
    return value;
  }
  return 'default';
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
