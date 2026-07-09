import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Logger } from '../logger.js';
import { createClaudeEngineProvider, resolveClaudePermissionModeForAccess } from './claude_provider.js';

function createProvider(config: {
  claudeDefaultModel: string | null;
  claudeModelAllowlist: string[];
}) {
  return createClaudeEngineProvider({
    claudeCliBin: 'claude',
    claudeDefaultModel: config.claudeDefaultModel,
    claudeModelAllowlist: config.claudeModelAllowlist,
    claudeIncludeDirectories: [],
    claudeAllowedTools: [],
    claudePermissionMode: 'default',
    claudeHeadlessTimeoutMs: 900_000,
    defaultCwd: os.tmpdir(),
  }, new Logger('error', path.join(os.tmpdir(), 'telegram-claude-provider.test.log')));
}

test('listModels falls back to the built-in Claude Code aliases', async () => {
  const provider = createProvider({
    claudeDefaultModel: null,
    claudeModelAllowlist: [],
  });

  const models = await provider.listModels();
  assert.deepEqual(models.map((entry) => entry.model), [
    'sonnet',
    'best',
    'fable',
    'opus',
    'haiku',
    'sonnet[1m]',
    'opus[1m]',
    'opusplan',
  ]);
  assert.equal(models[0]?.isDefault, true);
});

test('listModels exposes configured Claude aliases without duplicates', async () => {
  const provider = createProvider({
    claudeDefaultModel: 'sonnet',
    claudeModelAllowlist: [
      'sonnet',
      'best',
      'fable',
      'opus',
      'haiku',
      'sonnet[1m]',
      'opus[1m]',
      'opusplan',
    ],
  });

  const models = await provider.listModels();
  assert.deepEqual(models.map((entry) => entry.model), [
    'sonnet',
    'best',
    'fable',
    'opus',
    'haiku',
    'sonnet[1m]',
    'opus[1m]',
    'opusplan',
  ]);
  assert.equal(models[0]?.isDefault, true);
});

test('resolveClaudePermissionModeForAccess maps full access to bypassPermissions', () => {
  assert.equal(resolveClaudePermissionModeForAccess({
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    fallbackMode: 'default',
  }), 'bypassPermissions');
});

test('resolveClaudePermissionModeForAccess maps read-only to plan mode', () => {
  assert.equal(resolveClaudePermissionModeForAccess({
    approvalPolicy: 'on-request',
    sandboxMode: 'read-only',
    fallbackMode: 'default',
  }), 'plan');
});

test('resolveClaudePermissionModeForAccess keeps standard fallback modes for default access', () => {
  assert.equal(resolveClaudePermissionModeForAccess({
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    fallbackMode: 'acceptEdits',
  }), 'acceptEdits');
  assert.equal(resolveClaudePermissionModeForAccess({
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    fallbackMode: 'auto',
  }), 'auto');
  assert.equal(resolveClaudePermissionModeForAccess({
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    fallbackMode: 'dontAsk',
  }), 'dontAsk');
});

test('resolveClaudePermissionModeForAccess normalizes dangerous fallback modes back to default for standard access', () => {
  assert.equal(resolveClaudePermissionModeForAccess({
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    fallbackMode: 'bypassPermissions',
  }), 'default');
  assert.equal(resolveClaudePermissionModeForAccess({
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    fallbackMode: 'plan',
  }), 'default');
});
