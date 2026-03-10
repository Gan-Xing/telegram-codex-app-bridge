import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import { BridgeController } from './controller.js';
import type { TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';

function withController(run: (
  controller: BridgeController,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-thread-rename-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const bot = makeBot();
  const app = makeApp();
  const controller = new BridgeController(
    makeConfig(tempDir),
    store,
    new Logger('error', path.join(tempDir, 'bridge.log')),
    bot as any,
    app as any,
  );
  return Promise.resolve(run(controller, store, bot)).finally(() => {
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
  let nextMessageId = 100;
  return {
    answers: [] as string[],
    sent: [] as Array<{ chatId: string; text: string; keyboard: unknown }>,
    edits: [] as Array<{ chatId: string; messageId: number; text: string; keyboard: unknown }>,
    htmlSent: [] as Array<{ chatId: string; text: string; keyboard: unknown }>,
    async answerCallback(_id: string, text: string) {
      this.answers.push(text);
    },
    async sendMessage(chatId: string, text: string, keyboard?: unknown) {
      this.sent.push({ chatId, text, keyboard: keyboard ?? null });
      nextMessageId += 1;
      return nextMessageId;
    },
    async editMessage(chatId: string, messageId: number, text: string, keyboard?: unknown) {
      this.edits.push({ chatId, messageId, text, keyboard: keyboard ?? null });
    },
    async sendHtmlMessage(chatId: string, text: string, keyboard?: unknown) {
      this.htmlSent.push({ chatId, text, keyboard: keyboard ?? null });
      nextMessageId += 1;
      return nextMessageId;
    },
    async editHtmlMessage(chatId: string, messageId: number, text: string, keyboard?: unknown) {
      this.edits.push({ chatId, messageId, text, keyboard: keyboard ?? null });
    },
  };
}

function makeApp() {
  return {
    renameCalls: [] as Array<{ threadId: string; name: string }>,
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
    },
    async readThread(threadId: string) {
      return {
        threadId,
        name: 'Server thread',
        preview: 'Server thread preview',
        cwd: '/tmp/demo',
        modelProvider: 'openai',
        status: 'idle',
        updatedAt: 100,
      };
    },
    async listThreads() {
      return [{
        threadId: 'thread-1',
        name: 'Server thread',
        preview: 'Server thread preview',
        cwd: '/tmp/demo',
        modelProvider: 'openai',
        status: 'idle',
        updatedAt: 200,
      }];
    },
    async renameThread(threadId: string, name: string) {
      this.renameCalls.push({ threadId, name });
    },
  };
}

function makeCallback(data: string, messageId = 11): TelegramCallbackEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    userId: 'user-1',
    data,
    callbackQueryId: `cb-${messageId}`,
    messageId,
    languageCode: 'en',
  };
}

function makeText(text: string): TelegramTextEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    chatType: 'private',
    userId: 'user-1',
    text,
    messageId: 20,
    attachments: [],
    entities: [],
    replyToBot: false,
    languageCode: 'en',
  };
}

test('thread rename flow captures text, syncs codex rename, and persists override after confirmation', async () => {
  await withController(async (controller, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.cacheThreadList('chat-1', [{
      threadId: 'thread-1',
      name: 'Original thread name',
      preview: 'Original preview',
      cwd: '/tmp/demo',
      modelProvider: 'openai',
      status: 'idle',
      updatedAt: 100,
    }]);

    await (controller as any).handleCallback(makeCallback('thread:rename:start:thread-1'));
    assert.match(bot.sent.at(-1)?.text ?? '', /Rename thread thread-1/);
    const promptMessageId = 101;

    await (controller as any).handleText(makeText('  New    Thread   Name  '));
    assert.equal(bot.edits.at(-1)?.messageId, promptMessageId);
    assert.match(bot.edits.at(-1)?.text ?? '', /To: New Thread Name/);

    await (controller as any).handleCallback(makeCallback('thread:rename:confirm:thread-1', promptMessageId));
    const app = (controller as any).app;
    assert.deepEqual(app.renameCalls, [{ threadId: 'thread-1', name: 'New Thread Name' }]);
    assert.equal(store.getThreadNameOverride('chat-1', 'thread-1'), 'New Thread Name');
    assert.match(bot.edits.at(-1)?.text ?? '', /Thread renamed to: New Thread Name/);
    assert.match(bot.answers.at(-1) ?? '', /Decision recorded/);
    assert.match(bot.htmlSent.at(-1)?.text ?? '', /Recent threads/);
    assert.equal(store.getCachedThread('chat-1', 1)?.name, 'New Thread Name');
  });
});
