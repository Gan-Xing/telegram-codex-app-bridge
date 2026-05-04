import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramTextEvent } from '../telegram/gateway.js';
import { createBridgeComposition } from './composition.js';

function withComposition(run: (
  composition: ReturnType<typeof createBridgeComposition>,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
  app: ReturnType<typeof makeApp>,
  tempDir: string,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-review-command-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const bot = makeBot();
  const app = makeApp(tempDir);
  const composition = createBridgeComposition(
    makeConfig(tempDir),
    store,
    new Logger('error', path.join(tempDir, 'bridge.log')),
    bot as any,
    app as any,
  );
  return Promise.resolve(run(composition, store, bot, app, tempDir)).finally(async () => {
    await composition.turnLifecycle.abandonAllTurns();
    composition.turnGuidance.stop();
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

function makeBot() {
  let nextMessageId = 100;
  return {
    messages: [] as Array<{ chatId: string; text: string; keyboard: unknown }>,
    typings: [] as Array<{ chatId: string; topicId: number | null | undefined }>,
    async sendMessage(chatId: string, text: string, keyboard?: unknown) {
      this.messages.push({ chatId, text, keyboard: keyboard ?? null });
      nextMessageId += 1;
      return nextMessageId;
    },
    async sendHtmlMessage(chatId: string, text: string, keyboard?: unknown) {
      this.messages.push({ chatId, text, keyboard: keyboard ?? null });
      nextMessageId += 1;
      return nextMessageId;
    },
    async editMessage() {},
    async editHtmlMessage() {},
    async answerCallback() {},
    async clearMessageInlineKeyboard() {},
    async deleteMessage() {},
    async sendTypingInThread(chatId: string, topicId?: number | null) {
      this.typings.push({ chatId, topicId });
    },
    async sendMessageDraft() {},
    async start() {},
    stop() {},
    username: 'bot',
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
    reviewCalls: [] as any[],
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
    },
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'gpt-5.4',
        description: 'Default model',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread() {
      return {
        thread: {
          threadId: 'thread-1',
          name: 'Review thread',
          preview: 'Review thread',
          cwd: tempDir,
          modelProvider: 'openai',
          status: 'idle',
          updatedAt: Date.now(),
        },
        model: 'gpt-5.4',
        modelProvider: 'openai',
        reasoningEffort: 'medium',
        serviceTier: null,
        cwd: tempDir,
      };
    },
    async resumeThread({ threadId }: { threadId: string }) {
      return {
        thread: {
          threadId,
          name: 'Review thread',
          preview: 'Review thread',
          cwd: tempDir,
          modelProvider: 'openai',
          status: 'idle',
          updatedAt: Date.now(),
        },
        model: 'gpt-5.4',
        modelProvider: 'openai',
        reasoningEffort: 'medium',
        serviceTier: null,
        cwd: tempDir,
      };
    },
    async readThread() {
      return null;
    },
    async startTurn() {
      return { id: 'turn-ignored', status: 'running', threadId: 'thread-1' };
    },
    async startReview(options: any) {
      this.reviewCalls.push(options);
      return {
        turnId: `review-turn-${this.reviewCalls.length}`,
        reviewThreadId: options.delivery === 'detached' ? `review-thread-${this.reviewCalls.length}` : options.threadId,
      };
    },
    async steerTurn() {
      return { turnId: 'turn-ignored' };
    },
    async interruptTurn() {},
    async respond() {},
    async revealThread() {},
  };
}

function makeTextEvent(text: string): TelegramTextEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    mediaGroupId: null,
    scopeId: 'chat-1',
    chatType: 'private',
    userId: 'user-1',
    text,
    messageId: 1,
    attachments: [],
    entities: [],
    replyToBot: false,
    languageCode: 'en',
  };
}

test('/review routes to native review/start with the default uncommitted-changes target', async () => {
  await withComposition(async (composition, store, _bot, app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5.4', 'medium', 'en');
    store.setBinding('chat-1', 'thread-1', tempDir);
    composition.attachedThreads.add('thread-1');

    await composition.telegramRouter.handleText(makeTextEvent('/review'));

    assert.deepEqual(app.reviewCalls[0], {
      threadId: 'thread-1',
      target: { type: 'uncommittedChanges' },
      delivery: null,
      scopeId: 'chat-1',
    });
    assert.equal(composition.activeTurns.findByScope('chat-1')?.turnKind, 'review');
  });
});

test('/review base main detached starts a detached native review thread and rebinds the chat', async () => {
  await withComposition(async (composition, store, _bot, app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5.4', 'medium', 'en');
    store.setBinding('chat-1', 'thread-1', tempDir);
    composition.attachedThreads.add('thread-1');

    await composition.telegramRouter.handleText(makeTextEvent('/review base main detached'));

    assert.deepEqual(app.reviewCalls[0], {
      threadId: 'thread-1',
      target: { type: 'baseBranch', branch: 'main' },
      delivery: 'detached',
      scopeId: 'chat-1',
    });
    assert.equal(store.getBinding('chat-1')?.threadId, 'review-thread-1');
    assert.equal(composition.activeTurns.findByScope('chat-1')?.threadId, 'review-thread-1');
  });
});
