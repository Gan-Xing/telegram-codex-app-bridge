import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import { BridgeController } from './controller.js';

function withController(run: (
  controller: BridgeController,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-threads-panel-'));
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
    messages: [] as Array<{ chatId: string; text: string }>,
    htmlMessages: [] as Array<{
      chatId: string;
      text: string;
      inlineKeyboard: Array<Array<{ text: string; callback_data: string }>> | undefined;
      messageId: number;
    }>,
    htmlEdits: [] as Array<{
      chatId: string;
      messageId: number;
      text: string;
      inlineKeyboard: Array<Array<{ text: string; callback_data: string }>> | undefined;
    }>,
    callbackAnswers: [] as Array<{ id: string; text: string }>,
    async sendMessage(chatId: string, text: string) {
      this.messages.push({ chatId, text });
      nextMessageId += 1;
      return nextMessageId;
    },
    async sendHtmlMessage(
      chatId: string,
      text: string,
      inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
    ) {
      nextMessageId += 1;
      this.htmlMessages.push({ chatId, text, inlineKeyboard, messageId: nextMessageId });
      return nextMessageId;
    },
    async editHtmlMessage(
      chatId: string,
      messageId: number,
      text: string,
      inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
    ) {
      this.htmlEdits.push({ chatId, messageId, text, inlineKeyboard });
    },
    async editMessage() {},
    async answerCallback(id: string, text = 'OK') {
      this.callbackAnswers.push({ id, text });
    },
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

function makeCallbackEvent(messageId: number, overrides: Partial<TelegramCallbackEvent> = {}): TelegramCallbackEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    userId: 'user-1',
    data: 'thread:open:thread-1',
    callbackQueryId: 'cb-1',
    messageId,
    languageCode: 'en',
    ...overrides,
  };
}

test('threads panel renders inline keyboard buttons', async () => {
  await withController(async (controller, _store, bot) => {
    await (controller as any).showThreadsPanel('chat-1', undefined, null, 'en');

    assert.equal(bot.htmlMessages.length, 1);
    assert.match(bot.htmlMessages[0]?.text ?? '', /Recent threads/);
    assert.deepEqual(bot.htmlMessages[0]?.inlineKeyboard, [[
      { text: '1. Primary thread', callback_data: 'thread:open:thread-1' },
      { text: 'Rename', callback_data: 'thread:rename:start:thread-1' },
    ]]);
  });
});

test('thread open callback sends a fresh history preview card each time', async () => {
  await withController(async (controller, store, bot) => {
    await (controller as any).showThreadsPanel('chat-1', undefined, null, 'en');
    const panelMessageId = bot.htmlMessages[0]!.messageId;

    store.cacheThreadList('chat-1', [{
      threadId: 'thread-1',
      name: 'Primary thread',
      preview: 'Primary preview',
      cwd: '/tmp/demo',
      modelProvider: 'openai',
      status: 'idle',
      updatedAt: 200,
    }]);

    await (controller as any).handleThreadOpenCallback(makeCallbackEvent(panelMessageId), 'thread-1', 'en');
    assert.equal(store.getBinding('chat-1')?.threadId, 'thread-1');
    assert.equal(bot.htmlEdits.length, 1);
    assert.equal(bot.htmlEdits[0]?.messageId, panelMessageId);
    assert.equal(bot.htmlMessages.length, 2);
    assert.match(bot.htmlMessages[1]?.text ?? '', /Recent context/);

    await (controller as any).handleThreadOpenCallback(makeCallbackEvent(panelMessageId, { callbackQueryId: 'cb-2' }), 'thread-1', 'en');
    assert.equal(bot.htmlEdits.length, 2);
    assert.equal(bot.htmlMessages.length, 3);
    assert.equal(bot.htmlMessages[2]?.messageId, store.getThreadHistoryPreview('chat-1')?.messageId);
    assert.equal(bot.callbackAnswers.length, 2);
  });
});

test('history preview strips pasted preview cards from recent turn text', async () => {
  await withController(async (controller, store, bot) => {
    store.cacheThreadList('chat-1', [{
      threadId: 'thread-1',
      name: 'Codex历史项目',
      preview: 'Primary preview',
      cwd: '/tmp/demo',
      modelProvider: 'openai',
      status: 'idle',
      updatedAt: 200,
    }]);

    (controller as any).app.readThreadWithTurns = async (threadId: string) => ({
      threadId,
      name: 'Codex历史项目',
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
            {
              id: 'user-1',
              type: 'userMessage',
              phase: null,
              text: [
                '最近会话',
                '已切换到：旧线程',
                '线程：legacy-thread',
                '',
                '最近几轮：',
                '',
                '第 1 轮',
                '你: 我先只做第一步：把那个旧脚本测试修好，不碰提交和真实重启。',
                'Codex: 第一步完成了。',
                '',
                '这个？之前说的历史哪里去了？',
              ].join('\n'),
            },
            {
              id: 'assistant-1',
              type: 'agentMessage',
              phase: 'final_answer',
              text: [
                '最近会话',
                '线程：legacy-thread',
                'Codex: 第一步完成了。',
                '',
                '之前的历史还在 Codex thread 里，没有丢，只是这张卡片只显示最近几轮。',
              ].join('\n'),
            },
          ],
        },
      ],
    });

    await (controller as any).handleThreadOpenCallback(
      makeCallbackEvent(101, { languageCode: 'zh', callbackQueryId: 'cb-zh' }),
      'thread-1',
      'zh',
    );

    const preview = bot.htmlMessages.at(-1)?.text ?? '';
    assert.equal((preview.match(/最近会话/g) ?? []).length, 1);
    assert.match(preview, /线程：<code>thread-1<\/code>/);
    assert.match(preview, /你: 这个？之前说的历史哪里去了？/);
    assert.match(preview, /Codex: 之前的历史还在 Codex thread 里，没有丢，只是这张卡片只显示最近几轮。/);
    assert.doesNotMatch(preview, /legacy-thread/);
    assert.doesNotMatch(preview, /我先只做第一步/);
    assert.doesNotMatch(preview, /第一步完成了/);
  });
});
