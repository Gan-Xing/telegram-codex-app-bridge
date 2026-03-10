import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import { BridgeController } from './controller.js';
import type { TelegramWebAppEvent } from '../telegram/gateway.js';

function withController(run: (
  controller: BridgeController,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-threads-webapp-'));
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
    tgWebAppBaseUrl: 'https://bridge.example.com',
    webAppBindHost: '127.0.0.1',
    webAppBindPort: 8787,
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
    messages: [] as Array<{ chatId: string; text: string }>,
    htmlMessages: [] as Array<{ chatId: string; text: string }>,
    htmlEdits: [] as Array<{ chatId: string; messageId: number; text: string }>,
    webAppPanels: [] as Array<{ chatId: string; text: string; buttonText: string; url: string }>,
    async sendMessage(chatId: string, text: string) {
      this.messages.push({ chatId, text });
      nextMessageId += 1;
      return nextMessageId;
    },
    async sendHtmlMessageWithWebAppButton(chatId: string, text: string, buttonText: string, url: string) {
      this.webAppPanels.push({ chatId, text, buttonText, url });
      nextMessageId += 1;
      return nextMessageId;
    },
    async editHtmlMessageWithWebAppButton(chatId: string, _messageId: number, text: string, buttonText: string, url: string) {
      this.webAppPanels.push({ chatId, text, buttonText, url });
    },
    async sendHtmlMessage(chatId: string, text: string) {
      this.htmlMessages.push({ chatId, text });
      nextMessageId += 1;
      return nextMessageId;
    },
    async editHtmlMessage(chatId: string, messageId: number, text: string) {
      this.htmlEdits.push({ chatId, messageId, text });
    },
    async editMessage() {},
    async answerCallback() {},
    async clearMessageInlineKeyboard() {},
    async deleteMessage() {},
    async sendTypingInThread() {},
    async sendMessageDraft() {},
  };
}

function makeApp() {
  return {
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
    },
    async listThreads() {
      return [{
        threadId: 'thread-1',
        name: 'Primary thread',
        preview: 'Primary preview',
        cwd: '/tmp/demo',
        modelProvider: 'openai',
        status: 'idle',
        updatedAt: 200,
      }];
    },
    async resumeThread({ threadId }: { threadId: string }) {
      return {
        thread: {
          threadId,
          name: 'Primary thread',
          preview: 'Primary preview',
          cwd: '/tmp/demo',
          modelProvider: 'openai',
          status: 'idle',
          updatedAt: 200,
        },
        model: 'gpt-5',
        modelProvider: 'openai',
        reasoningEffort: 'medium',
        cwd: '/tmp/demo',
      };
    },
    async readThreadWithTurns(threadId: string) {
      return {
        threadId,
        name: 'Primary thread',
        preview: 'Primary preview',
        cwd: '/tmp/demo',
        modelProvider: 'openai',
        status: 'idle',
        updatedAt: 200,
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            error: null,
            items: [
              { id: 'user-1', type: 'userMessage', phase: null, text: 'Why did the old interrupt button remain?' },
              { id: 'assistant-1', type: 'agentMessage', phase: 'final_answer', text: 'Because the preview card was not being replaced after a rebase.' },
            ],
          },
        ],
      };
    },
  };
}

function makeWebAppEvent(data: string): TelegramWebAppEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    userId: 'user-1',
    data,
    messageId: 10,
    buttonText: '线程面板',
    languageCode: 'en',
  };
}

test('threads panel renders web app launcher url with payload', async () => {
  await withController(async (controller, _store, bot) => {
    await (controller as any).showThreadsPanel('chat-1', undefined, null, 'en');
    assert.equal(bot.webAppPanels.length, 1);
    const url = new URL(bot.webAppPanels[0]!.url);
    assert.equal(url.origin, 'https://bridge.example.com');
    assert.equal(url.pathname, '/webapp/threads');
    assert.ok(url.searchParams.get('payload'));
  });
});

test('web app open action binds thread, sends open summary, and reuses one history preview card', async () => {
  await withController(async (controller, store, bot) => {
    store.cacheThreadList('chat-1', [{
      threadId: 'thread-1',
      name: 'Primary thread',
      preview: 'Primary preview',
      cwd: '/tmp/demo',
      modelProvider: 'openai',
      status: 'idle',
      updatedAt: 200,
    }]);

    await (controller as any).handleWebApp(
      makeWebAppEvent(JSON.stringify({ v: 1, kind: 'threads-panel', action: 'open', threadId: 'thread-1' })),
    );

    assert.equal(store.getBinding('chat-1')?.threadId, 'thread-1');
    assert.match(bot.messages.at(-1)?.text ?? '', /Bound to thread thread-1/);
    assert.equal(bot.htmlMessages.length, 1);
    assert.match(bot.htmlMessages[0]?.text ?? '', /Recent context/);
    assert.match(bot.htmlMessages[0]?.text ?? '', /Because the preview card was not being replaced/);

    await (controller as any).handleWebApp(
      makeWebAppEvent(JSON.stringify({ v: 1, kind: 'threads-panel', action: 'open', threadId: 'thread-1' })),
    );

    assert.equal(bot.htmlMessages.length, 1);
    assert.equal(bot.htmlEdits.length, 1);
    assert.equal(bot.htmlEdits[0]?.messageId, 102);
  });
});
