import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { createEngineProvider } from './factory.js';

function makeConfig(engine: AppConfig['bridgeEngine']): AppConfig {
  const tempDir = path.join(os.tmpdir(), `telegram-codex-engine-factory-${engine}`);
  return {
    envFile: path.join(tempDir, '.env'),
    bridgeEngine: engine,
    bridgeInstanceId: engine === 'codex' ? null : engine,
    bridgeHome: tempDir,
    tgBotToken: 'token',
    tgAllowedUserId: 'user-1',
    tgAllowedChatId: null,
    tgAllowedTopicId: null,
    codexCliBin: 'codex',
    geminiCliBin: 'gemini',
    geminiDefaultModel: 'gemini-3-pro-preview',
    geminiModelAllowlist: ['gemini-3-pro-preview'],
    geminiIncludeDirectories: [],
    geminiHeadlessTimeoutMs: 300_000,
    codexAppAutolaunch: false,
    codexAppLaunchCmd: '',
    codexAppSyncOnOpen: false,
    codexAppSyncOnTurnComplete: false,
    storePath: path.join(tempDir, 'bridge.sqlite'),
    logLevel: 'error',
    defaultCwd: tempDir,
    defaultApprovalPolicy: 'on-request',
    defaultSandboxMode: 'workspace-write',
    telegramPollIntervalMs: 1000,
    telegramPreviewThrottleMs: 100,
    threadListLimit: 10,
    statusPath: path.join(tempDir, 'status.json'),
    logPath: path.join(tempDir, 'bridge.log'),
    lockPath: path.join(tempDir, 'bridge.lock'),
  };
}

test('createEngineProvider returns a codex provider for codex instances', () => {
  const provider = createEngineProvider(
    makeConfig('codex'),
    new Logger('error', path.join(os.tmpdir(), 'telegram-codex-engine-factory.log')),
  );

  assert.equal(provider.engine, 'codex');
});

test('createEngineProvider returns a gemini provider for gemini instances', () => {
  const provider = createEngineProvider(
    makeConfig('gemini'),
    new Logger('error', path.join(os.tmpdir(), 'telegram-gemini-engine-factory.log')),
  );

  assert.equal(provider.engine, 'gemini');
});

test('createEngineProvider returns a claude provider for claude instances', () => {
  const provider = createEngineProvider(
    makeConfig('claude'),
    new Logger('error', path.join(os.tmpdir(), 'telegram-claude-engine-factory.log')),
  );

  assert.equal(provider.engine, 'claude');
});
