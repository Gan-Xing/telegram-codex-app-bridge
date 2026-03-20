import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Logger } from '../logger.js';
import { ServiceControlCoordinator } from './service_control.js';

function makeHost(overrides: Record<string, unknown> = {}) {
  const messages: Array<{ scopeId: string; text: string }> = [];
  const host = {
    logger: new Logger('error', path.join(os.tmpdir(), 'telegram-codex-service-control.test.log')),
    restartMode: 'service' as const,
    app: {
      connected: true,
      stopCalls: 0,
      startCalls: 0,
      async stop() {
        this.stopCalls += 1;
        this.connected = false;
      },
      async start() {
        this.startCalls += 1;
        this.connected = true;
      },
      isConnected() {
        return this.connected;
      },
      async readAccountIdentity() {
        return {
          email: 'ganxingus@gmail.com',
          name: 'GanXing',
          authMode: 'chatgpt',
          accountId: 'f2275ca4-b687-40c4-8015-83ef40559ee6',
        };
      },
      getAccountIdentity() {
        return null;
      },
      async readAccountRateLimits() {
        return {
          limitId: 'codex',
          limitName: null,
          primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1773082597 },
          secondary: { usedPercent: 54, windowDurationMins: 10080, resetsAt: 1773531564 },
          credits: null,
          planType: 'pro',
        };
      },
      getAccountRateLimits() {
        return null;
      },
    },
    messages: {
      async sendMessage(scopeId: string, text: string) {
        messages.push({ scopeId, text });
        return 1;
      },
    },
    localeForChat() {
      return 'zh' as const;
    },
    activeTurnCount() {
      return 0;
    },
    runtimeStatus: {
      cleared: 0,
      lastError: null as string | null,
      clearLastError() {
        this.cleared += 1;
        this.lastError = null;
      },
      setLastError(error: unknown) {
        this.lastError = error instanceof Error ? error.message : String(error);
      },
      getLastError() {
        return this.lastError;
      },
    },
    updateStatusCalls: 0,
    updateStatus() {
      this.updateStatusCalls += 1;
    },
    spawnRestartScriptCalls: [] as Array<{ scopeId: string; locale: string }>,
    async spawnRestartScript(scopeId: string, locale: string) {
      this.spawnRestartScriptCalls.push({ scopeId, locale });
    },
    restartBridgeCalls: 0,
    async restartBridge() {
      this.restartBridgeCalls += 1;
    },
    sentMessages: messages,
    ...overrides,
  };
  return host;
}

test('reconnect refreshes the codex session and reports rate limits', async () => {
  const host = makeHost();
  const service = new ServiceControlCoordinator(host as any);

  await service.reconnect('chat-1', 'zh');

  assert.equal(host.app.stopCalls, 1);
  assert.equal(host.app.startCalls, 1);
  assert.equal(host.runtimeStatus.cleared, 1);
  assert.equal(host.sentMessages.length, 2);
  assert.match(host.sentMessages[1]?.text ?? '', /Codex 会话已刷新/);
  assert.match(host.sentMessages[1]?.text ?? '', /账号：ganxingus@gmail.com \(chatgpt, id:f2275ca4\)/);
  assert.match(host.sentMessages[1]?.text ?? '', /5小时额度：已用 11%/);
  assert.match(host.sentMessages[1]?.text ?? '', /本周额度：已用 54%/);
});

test('maintenance commands are blocked while any active turn is running', async () => {
  const host = makeHost({
    activeTurnCount() {
      return 1;
    },
  });
  const service = new ServiceControlCoordinator(host as any);

  await service.reconnect('chat-1', 'zh');
  await service.restart('chat-1', 'zh');

  assert.equal(host.app.stopCalls, 0);
  assert.equal(host.spawnRestartScriptCalls.length, 0);
  assert.equal(host.sentMessages.length, 2);
  assert.match(host.sentMessages[0]?.text ?? '', /先等当前回复结束/);
});

test('restart queues the safe restart script for the current scope', async () => {
  const host = makeHost();
  const service = new ServiceControlCoordinator(host as any);

  await service.restart('chat-1', 'zh');

  assert.deepEqual(host.spawnRestartScriptCalls, [{ scopeId: 'chat-1', locale: 'zh' }]);
  assert.match(host.sentMessages[0]?.text ?? '', /桥接重启已排队/);
});

test('restart performs an in-process bridge restart on manual platforms', async () => {
  const host = makeHost({
    restartMode: 'in-process',
  });
  const service = new ServiceControlCoordinator(host as any);

  await service.restart('chat-1', 'zh');

  assert.equal(host.restartBridgeCalls, 1);
  assert.deepEqual(host.spawnRestartScriptCalls, []);
  assert.match(host.sentMessages[0]?.text ?? '', /桥接已重启/);
});

test('restart reports unsupported hosts clearly when restart is unavailable', async () => {
  const host = makeHost({
    restartMode: 'none',
  });
  const service = new ServiceControlCoordinator(host as any);

  await service.restart('chat-1', 'zh');

  assert.equal(host.restartBridgeCalls, 0);
  assert.deepEqual(host.spawnRestartScriptCalls, []);
  assert.match(host.sentMessages[0]?.text ?? '', /当前主机不支持桥接自重启/);
});
