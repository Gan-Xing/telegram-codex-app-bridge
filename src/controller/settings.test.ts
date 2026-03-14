import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import type { ModelInfo } from '../types.js';
import { createBridgeComposition } from './composition.js';

function withComposition(run: (
  composition: ReturnType<typeof createBridgeComposition>,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-settings-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const bot = makeBot();
  const composition = createBridgeComposition(
    makeConfig(tempDir),
    store,
    new Logger('error', path.join(tempDir, 'bridge.log')),
    bot as any,
    makeApp() as any,
  );
  return Promise.resolve(run(composition, store, bot)).finally(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

function makeConfig(tempDir: string): AppConfig {
  return {
    tgBotToken: 'token',
    tgAllowedUserId: 'user-1',
    tgAllowedChatId: null,
    tgAllowedTopicId: null,
    codexCliBin: 'codex',
    codexAppAutolaunch: false,
    codexAppLaunchCmd: '',
    codexAppSyncOnOpen: false,
    codexAppSyncOnTurnComplete: false,
    storePath: path.join(tempDir, 'bridge.sqlite'),
    logLevel: 'error',
    defaultCwd: '/tmp/demo',
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
  return {
    answers: [] as string[],
    edits: [] as Array<{ messageId: number; text: string; keyboard: unknown }>,
    messages: [] as string[],
    async answerCallback(_id: string, text: string) {
      this.answers.push(text);
    },
    async editHtmlMessage(_chatId: string, messageId: number, text: string, keyboard?: unknown) {
      this.edits.push({ messageId, text, keyboard: keyboard ?? null });
    },
    async sendHtmlMessage() { return 77; },
    async sendMessage(_chatId: string, text: string) {
      this.messages.push(text);
      return 77;
    },
    async editMessage() {},
    async clearMessageInlineKeyboard() {},
    async deleteMessage() {},
    async sendTypingInThread() {},
    async sendMessageDraft() {},
    async start() {},
    stop() {},
    username: 'bot',
  };
}

function makeApp() {
  const models: ModelInfo[] = [{
    id: 'model-gpt-5',
    model: 'gpt-5',
    displayName: 'OpenAI gpt-5',
    description: 'Reasoning model',
    isDefault: true,
    supportedReasoningEfforts: ['medium', 'high'],
    defaultReasoningEffort: 'medium',
  }];
  return {
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
    },
    async listModels() {
      return models;
    },
  };
}

function makeCallback(data: string): TelegramCallbackEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    userId: 'user-1',
    data,
    callbackQueryId: 'cb-1',
    messageId: 77,
    languageCode: 'en',
  };
}

test('settings callback toggles guided-plan preferences and refreshes the settings home panel', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setChatGuidedPlanPreferences('chat-1', {
      confirmPlanBeforeExecute: true,
      autoQueueMessages: true,
      persistPlanHistory: true,
    });
    store.setBinding('chat-1', 'thread-1', '/tmp/demo');

    await composition.telegramRouter.handleCallback(makeCallback('settings:queue:off'));

    const settings = store.getChatSettings('chat-1');
    assert.equal(settings?.autoQueueMessages, false);
    assert.match(bot.edits[0]?.text ?? '', /<b>Settings<\/b>/);
    assert.match(bot.answers[0] ?? '', /Auto queue: no/);
  });
});

test('settings callback updates service tier inside the model settings panel', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');

    await composition.telegramRouter.handleCallback(makeCallback('settings:tier:flex'));

    const settings = store.getChatSettings('chat-1');
    assert.equal(settings?.serviceTier, 'flex');
    assert.match(bot.edits[0]?.text ?? '', /Service tier: <b>Flex<\/b>/);
    assert.match(bot.answers[0] ?? '', /Service tier: Flex/);
  });
});

test('mode callback clears pending guided-plan prompts and shows the current scope', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setChatCollaborationMode('chat-1', 'plan');
    store.savePlanSession({
      sessionId: 'session-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      sourceTurnId: 'turn-1',
      executionTurnId: null,
      state: 'awaiting_plan_confirmation',
      confirmationRequired: true,
      confirmedPlanVersion: null,
      latestPlanVersion: 1,
      currentPromptId: 'prompt-1',
      currentApprovalId: null,
      queueDepth: 0,
      lastPlanMessageId: 10,
      lastPromptMessageId: 77,
      lastApprovalMessageId: null,
      createdAt: 1000,
      updatedAt: 1001,
      resolvedAt: null,
    });

    await composition.telegramRouter.handleCallback(makeCallback('settings:mode:default'));

    assert.equal(store.getChatSettings('chat-1')?.collaborationMode, null);
    assert.equal(store.getPlanSession('session-1')?.state, 'cancelled');
    assert.match(bot.edits[0]?.text ?? '', /Scope: chat-1 \/ root/);
    assert.match(bot.answers[0] ?? '', /Mode: Default/);
  });
});

test('/plan off resets mode to default instead of storing a separate mode value', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatCollaborationMode('chat-1', 'plan');

    await composition.telegramRouter.handleCommand({ scopeId: 'chat-1' } as any, 'en', 'plan', ['off']);

    assert.equal(store.getChatSettings('chat-1')?.collaborationMode, null);
    assert.match(bot.messages.at(-1) ?? '', /Scope: chat-1 \/ root/);
  });
});

test('/fast sets service tier for the next turn', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');

    await composition.telegramRouter.handleCommand({ scopeId: 'chat-1' } as any, 'en', 'fast', []);

    assert.equal(store.getChatSettings('chat-1')?.serviceTier, 'fast');
    assert.match(bot.messages.at(-1) ?? '', /Configured service tier: Fast/);
  });
});

test('service tier changes are blocked while a turn is active', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    composition.activeTurns.set('turn-1', { turnId: 'turn-1', scopeId: 'chat-1' } as any);

    await composition.telegramRouter.handleCommand({ scopeId: 'chat-1' } as any, 'en', 'tier', ['flex']);

    assert.equal(store.getChatSettings('chat-1')?.serviceTier, null);
    assert.match(bot.messages.at(-1) ?? '', /Cannot change service tier while a turn is active/);
  });
});
