import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import { ThreadAttachmentRegistry } from './bridge_runtime.js';
import { ThreadSessionService } from './thread_session.js';
import type { AppThread, ThreadBinding, ThreadSessionState } from '../types.js';

function withService(run: (
  service: ThreadSessionService,
  store: BridgeStore,
  app: ReturnType<typeof makeApp>,
  sentMessages: string[],
  tempDir: string,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-thread-session-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const sentMessages: string[] = [];
  const app = makeApp(tempDir);
  const service = new ThreadSessionService({
    config: makeConfig(tempDir),
    store,
    logger: new Logger('error', path.join(tempDir, 'bridge.log')),
    app: app as any,
    bot: {
      async getFile() {
        throw new Error('not implemented');
      },
      async downloadResolvedFile() {
        throw new Error('not implemented');
      },
    },
    attachedThreads: new ThreadAttachmentRegistry(),
    localeForChat: () => 'zh',
    sendMessage: async (_scopeId, text) => {
      sentMessages.push(text);
      return sentMessages.length;
    },
    updateStatus: () => {},
  });
  return Promise.resolve(run(service, store, app, sentMessages, tempDir)).finally(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

function makeConfig(tempDir: string): AppConfig {
  return {
    envFile: path.join(tempDir, '.env'),
    bridgeEngine: 'codex',
    bridgeInstanceId: null,
    bridgeHome: tempDir,
    tgBotToken: 'token',
    tgAllowedUserId: 'user-1',
    tgAllowedChatId: null,
    tgAllowedTopicId: null,
    codexCliBin: 'codex',
    codexProviderProfiles: [{
      id: 'openai-native',
      displayName: 'OpenAI Codex',
      cliBin: 'codex',
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
    }],
    codexDefaultProviderProfileId: 'openai-native',
    geminiCliBin: 'gemini',
    geminiDefaultModel: 'gemini-3-pro-preview',
    geminiModelAllowlist: ['gemini-3-pro-preview'],
    geminiIncludeDirectories: [],
    geminiHeadlessTimeoutMs: 300_000,
    claudeCliBin: 'claude',
    claudeDefaultModel: null,
    claudeModelAllowlist: [],
    claudeIncludeDirectories: [],
    claudeAllowedTools: [],
    claudePermissionMode: 'default',
    claudeHeadlessTimeoutMs: 300_000,
    opencodeCliBin: 'opencode',
    opencodeDefaultModel: null,
    opencodeDefaultAgent: null,
    opencodeServerHostname: '127.0.0.1',
    opencodeServerPort: null,
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
    telegramPreviewThrottleMs: 50,
    threadListLimit: 10,
    statusPath: path.join(tempDir, 'status.json'),
    logPath: path.join(tempDir, 'bridge.log'),
    lockPath: path.join(tempDir, 'bridge.lock'),
  };
}

function makeThread(threadId: string, cwd: string): AppThread {
  return {
    threadId,
    name: 'Recovered thread',
    preview: 'Recovered preview',
    cwd,
    modelProvider: 'openai',
    status: 'idle',
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

function makeSession(threadId: string, cwd: string): ThreadSessionState {
  return {
    thread: makeThread(threadId, cwd),
    model: 'gpt-5.4',
    modelProvider: 'openai',
    reasoningEffort: 'medium',
    serviceTier: null,
    cwd,
  };
}

function makeApp(tempDir: string) {
  return {
    capabilities: {
      threads: true,
      reveal: true,
      guidedPlan: 'full',
      approvals: 'full',
      steerActiveTurn: true,
      rateLimits: true,
      reasoningEffort: true,
      serviceTier: true,
      reconnect: true,
    },
    resumeCalls: 0,
    readCalls: 0,
    startThreadCalls: 0,
    startTurnCalls: 0,
    startTurnPayloads: [] as any[],
    startTurnFailures: [] as Error[],
    resumeFailures: [] as Error[],
    readThreadResult: makeThread('thread-1', tempDir) as AppThread | null,
    availableModels: [{
      id: 'gpt-5.4',
      model: 'gpt-5.4',
      displayName: 'gpt-5.4',
      description: 'Default model',
      isDefault: true,
      supportedReasoningEfforts: ['medium'],
      defaultReasoningEffort: 'medium',
    }],
    async listModels() {
      return this.availableModels;
    },
    async startThread() {
      this.startThreadCalls += 1;
      return makeSession(`new-thread-${this.startThreadCalls}`, tempDir);
    },
    async resumeThread({ threadId }: { threadId: string }) {
      this.resumeCalls += 1;
      const failure = this.resumeFailures.shift() ?? null;
      if (failure) {
        throw failure;
      }
      return makeSession(threadId, tempDir);
    },
    async readThread() {
      this.readCalls += 1;
      return this.readThreadResult;
    },
    async startTurn(options: { threadId: string; collaborationMode?: string | null }) {
      const { threadId } = options;
      this.startTurnCalls += 1;
      this.startTurnPayloads.push(options);
      const failure = this.startTurnFailures.shift() ?? null;
      if (failure) {
        throw failure;
      }
      return { id: `turn-${this.startTurnCalls}`, status: 'running', threadId };
    },
    async revealThread() {},
  };
}

function seedBinding(store: BridgeStore, tempDir: string): ThreadBinding {
  store.setChatSettings('chat-1', 'gpt-5.4', 'medium', 'zh');
  store.setBinding('chat-1', 'thread-1', tempDir);
  return store.getBinding('chat-1')!;
}

test('ensureThreadReady retries the same thread when resume fails transiently', async () => {
  await withService(async (service, store, app, sentMessages, tempDir) => {
    const binding = seedBinding(store, tempDir);
    app.resumeFailures.push(new Error('thread not found'));

    const resolved = await service.ensureThreadReady('chat-1', binding);

    assert.equal(resolved.threadId, 'thread-1');
    assert.equal(store.getBinding('chat-1')?.threadId, 'thread-1');
    assert.equal(app.resumeCalls, 2);
    assert.equal(app.readCalls, 1);
    assert.equal(app.startThreadCalls, 0);
    assert.deepEqual(sentMessages, []);
  });
});

test('startTurnWithRecovery retries the same thread before creating a replacement', async () => {
  await withService(async (service, store, app, sentMessages, tempDir) => {
    const binding = seedBinding(store, tempDir);
    app.startTurnFailures.push(new Error('thread not found'));

    const result = await service.startTurnWithRecovery(
      'chat-1',
      binding,
      [{ type: 'text', text: 'hello', text_elements: [] }],
    );

    assert.equal(result.threadId, 'thread-1');
    assert.equal(store.getBinding('chat-1')?.threadId, 'thread-1');
    assert.equal(app.startTurnCalls, 2);
    assert.equal(app.resumeCalls, 1);
    assert.equal(app.readCalls, 1);
    assert.equal(app.startThreadCalls, 0);
    assert.deepEqual(sentMessages, []);
  });
});

test('startTurnWithRecovery sends explicit default collaboration mode for Codex turns', async () => {
  await withService(async (service, store, app, _sentMessages, tempDir) => {
    const binding = seedBinding(store, tempDir);
    store.setChatCollaborationMode('chat-1', null);

    await service.startTurnWithRecovery(
      'chat-1',
      binding,
      [{ type: 'text', text: 'hello', text_elements: [] }],
    );

    assert.equal(app.startTurnPayloads[0]?.collaborationMode, 'default');
  });
});

test('startTurnWithRecovery resolves a concrete default model for Codex default collaboration mode', async () => {
  await withService(async (service, store, app, _sentMessages, tempDir) => {
    store.setChatSettings('chat-1', null, 'medium', 'zh');
    store.setBinding('chat-1', 'thread-1', tempDir);
    store.setChatCollaborationMode('chat-1', null);

    await service.startTurnWithRecovery(
      'chat-1',
      store.getBinding('chat-1')!,
      [{ type: 'text', text: 'hello', text_elements: [] }],
    );

    assert.equal(app.startTurnPayloads[0]?.collaborationMode, 'default');
    assert.equal(app.startTurnPayloads[0]?.model, 'gpt-5.4');
  });
});
