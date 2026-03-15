import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getDefaultLockPath,
  getDefaultLogPath,
  getDefaultStatusPath,
  getDefaultStorePath,
  loadConfig,
  resolveBridgeRuntimePaths,
} from './config.js';

function withPatchedEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('resolveBridgeRuntimePaths preserves the legacy default layout for codex', () => {
  const homeDir = path.join(os.tmpdir(), 'telegram-codex-config-home');
  const paths = resolveBridgeRuntimePaths({}, homeDir);
  const expectedHome = path.join(homeDir, '.telegram-codex-app-bridge');

  assert.equal(paths.bridgeEngine, 'codex');
  assert.equal(paths.bridgeInstanceId, null);
  assert.equal(paths.bridgeHome, expectedHome);
  assert.equal(paths.storePath, getDefaultStorePath(expectedHome));
  assert.equal(paths.statusPath, getDefaultStatusPath(expectedHome));
  assert.equal(paths.logPath, getDefaultLogPath(expectedHome));
  assert.equal(paths.lockPath, getDefaultLockPath(expectedHome));
});

test('resolveBridgeRuntimePaths derives a dedicated instance home for gemini by default', () => {
  const homeDir = path.join(os.tmpdir(), 'telegram-codex-gemini-config-home');
  const paths = resolveBridgeRuntimePaths({ BRIDGE_ENGINE: 'gemini' }, homeDir);
  const expectedHome = path.join(homeDir, '.telegram-codex-app-bridge', 'instances', 'gemini');

  assert.equal(paths.bridgeEngine, 'gemini');
  assert.equal(paths.bridgeInstanceId, 'gemini');
  assert.equal(paths.bridgeHome, expectedHome);
  assert.equal(paths.storePath, path.join(expectedHome, 'data', 'bridge.sqlite'));
});

test('loadConfig reads bridge runtime settings from ENV_FILE', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-config-test-'));
  const envFile = path.join(tempDir, '.env.gemini');
  const workspace = path.join(tempDir, 'workspace');
  const bridgeHome = path.join(tempDir, 'bridge-home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(envFile, [
    'TG_BOT_TOKEN=test-token',
    'TG_ALLOWED_USER_ID=1',
    'BRIDGE_ENGINE=gemini',
    'BRIDGE_INSTANCE_ID=linux144-gemini',
    `BRIDGE_HOME=${bridgeHome}`,
    `DEFAULT_CWD=${workspace}`,
    'LOG_LEVEL=debug',
  ].join('\n'), 'utf8');

  withPatchedEnv({
    ENV_FILE: envFile,
    TG_BOT_TOKEN: undefined,
    TG_ALLOWED_USER_ID: undefined,
    BRIDGE_ENGINE: undefined,
    BRIDGE_INSTANCE_ID: undefined,
    BRIDGE_HOME: undefined,
    DEFAULT_CWD: undefined,
    LOG_LEVEL: undefined,
    STORE_PATH: undefined,
    STATUS_PATH: undefined,
    LOG_PATH: undefined,
    LOCK_PATH: undefined,
  }, () => {
    const config = loadConfig();
    assert.equal(config.envFile, envFile);
    assert.equal(config.bridgeEngine, 'gemini');
    assert.equal(config.bridgeInstanceId, 'linux144-gemini');
    assert.equal(config.bridgeHome, bridgeHome);
    assert.equal(config.defaultCwd, workspace);
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.storePath, path.join(bridgeHome, 'data', 'bridge.sqlite'));
    assert.equal(config.statusPath, path.join(bridgeHome, 'runtime', 'status.json'));
    assert.equal(config.logPath, path.join(bridgeHome, 'logs', 'service.log'));
    assert.equal(config.lockPath, path.join(bridgeHome, 'runtime', 'bridge.lock'));
  });
});
