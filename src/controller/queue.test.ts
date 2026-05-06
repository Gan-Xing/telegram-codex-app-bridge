import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';
import type { TelegramInboundAttachment } from '../telegram/media.js';
import { createBridgeComposition } from './composition.js';

function withComposition(run: (
  composition: ReturnType<typeof createBridgeComposition>,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
  app: ReturnType<typeof makeApp>,
  tempDir: string,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-queue-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const bot = makeBot();
  const app = makeApp();
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
    }],
    codexDefaultProviderProfileId: 'openai-native',
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
    messages: [] as Array<{ chatId: string; text: string; keyboard: unknown }>,
    messageEdits: [] as Array<{ chatId: string; messageId: number; text: string; keyboard: unknown }>,
    htmlMessages: [] as Array<{ chatId: string; text: string; keyboard: unknown }>,
    htmlEdits: [] as Array<{ chatId: string; messageId: number; text: string; keyboard: unknown }>,
    deletedMessages: [] as Array<{ chatId: string; messageId: number }>,
    clearedButtons: [] as Array<{ chatId: string; messageId: number }>,
    typings: [] as Array<{ chatId: string; topicId: number | null | undefined }>,
    downloads: [] as Array<{ remotePath: string; localPath: string }>,
    async answerCallback(_id: string, text: string) {
      this.answers.push(text);
    },
    async sendMessage(chatId: string, text: string, keyboard?: unknown) {
      this.messages.push({ chatId, text, keyboard: keyboard ?? null });
      nextMessageId += 1;
      return nextMessageId;
    },
    async editMessage(chatId: string, messageId: number, text: string, keyboard?: unknown) {
      this.messageEdits.push({ chatId, messageId, text, keyboard: keyboard ?? null });
    },
    async sendHtmlMessage(chatId: string, text: string, keyboard?: unknown) {
      this.htmlMessages.push({ chatId, text, keyboard: keyboard ?? null });
      nextMessageId += 1;
      return nextMessageId;
    },
    async editHtmlMessage(chatId: string, messageId: number, text: string, keyboard?: unknown) {
      this.htmlEdits.push({ chatId, messageId, text, keyboard: keyboard ?? null });
    },
    async clearMessageInlineKeyboard(chatId: string, messageId: number) {
      this.clearedButtons.push({ chatId, messageId });
    },
    async deleteMessage(chatId: string, messageId: number) {
      this.deletedMessages.push({ chatId, messageId });
    },
    async sendTypingInThread(chatId: string, topicId?: number | null) {
      this.typings.push({ chatId, topicId });
    },
    async sendMessageDraft() {},
    async getFile(fileId: string) {
      return {
        file_path: `photos/${fileId}.jpg`,
        file_size: 512,
      };
    },
    async downloadResolvedFile(remotePath: string, localPath: string) {
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      await fsp.writeFile(localPath, 'queued attachment');
      this.downloads.push({ remotePath, localPath });
    },
    async start() {},
    stop() {},
    username: 'bot',
  };
}

function makeApp() {
  return {
    startTurnCalls: [] as any[],
    steerTurnCalls: [] as any[],
    interruptTurnCalls: [] as any[],
    interruptError: null as Error | null,
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
    },
    async startTurn(options: any) {
      this.startTurnCalls.push(options);
      return { id: `turn-${this.startTurnCalls.length}`, status: 'running' };
    },
    async steerTurn(options: any) {
      this.steerTurnCalls.push(options);
      return { turnId: options.turnId };
    },
    async interruptTurn(threadId: string, turnId: string, scopeId?: string | null) {
      this.interruptTurnCalls.push({ threadId, turnId, scopeId: scopeId ?? null });
      if (this.interruptError) {
        throw this.interruptError;
      }
    },
  };
}

function makeTextEvent(text: string, attachments: TelegramInboundAttachment[] = []): TelegramTextEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    mediaGroupId: null,
    scopeId: 'chat-1',
    chatType: 'private',
    userId: 'user-1',
    text,
    messageId: 1,
    attachments,
    entities: [],
    replyToBot: false,
    languageCode: 'en',
  };
}

function makeCallbackEvent(data: string, messageId: number): TelegramCallbackEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    userId: 'user-1',
    data,
    callbackQueryId: 'cb-1',
    messageId,
    languageCode: 'en',
  };
}

function makePhotoAttachment(): TelegramInboundAttachment {
  return {
    kind: 'photo',
    fileId: 'file-1',
    fileUniqueId: 'unique-1',
    fileName: null,
    mimeType: 'image/jpeg',
    fileSize: 512,
    width: 800,
    height: 600,
    durationSeconds: null,
    isAnimated: false,
    isVideo: false,
  };
}

async function waitFor(assertion: () => void, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }
}

async function seedActiveTurn(composition: ReturnType<typeof createBridgeComposition>, store: BridgeStore, cwd: string): Promise<void> {
  store.setBinding('chat-1', 'thread-1', cwd);
  composition.attachedThreads.add('thread-1');
  await composition.turnExecution.startIncomingTurn(
    'chat-1',
    'chat-1',
    'private',
    null,
    store.getBinding('chat-1')!,
    [{ type: 'text', text: 'Initial turn', text_elements: [] }],
  );
}

test('running messages are queued and offered a steer choice', async () => {
  await withComposition(async (composition, store, bot, _app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    await seedActiveTurn(composition, store, tempDir);

    await composition.telegramRouter.handleText(makeTextEvent('Follow up while busy'));

    const queued = store.peekQueuedTurnInput('chat-1');
    assert.equal(queued?.status, 'queued');
    assert.equal(queued?.sourceSummary, 'Follow up while busy');
    assert.match(bot.messageEdits.at(-1)?.text ?? '', /Insert it into the current reply instead\?/);
  });
});

test('guidance callback removes the queued item and steers the active turn', async () => {
  await withComposition(async (composition, store, bot, app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    await seedActiveTurn(composition, store, tempDir);

    await composition.telegramRouter.handleText(makeTextEvent('Tighten the scope'));

    const queued = store.peekQueuedTurnInput('chat-1');
    assert.ok(queued?.queueId);
    assert.ok(queued?.telegramMessageId);

    await composition.telegramRouter.handleCallback(
      makeCallbackEvent(`guidance:${queued!.queueId}:steer`, queued!.telegramMessageId!),
    );

    assert.equal(store.countQueuedTurnInputs('chat-1'), 0);
    assert.equal(app.steerTurnCalls.length, 1);
    assert.equal(app.steerTurnCalls[0]?.threadId, 'thread-1');
    assert.equal(app.steerTurnCalls[0]?.turnId, 'turn-1');
    assert.equal(app.steerTurnCalls[0]?.input?.[0]?.text, 'Tighten the scope');
    assert.equal(bot.deletedMessages.at(-1)?.messageId, queued?.telegramMessageId);
    assert.match(bot.answers.at(-1) ?? '', /Inserted into the current reply/);
  });
});

test('/guide inserts guidance into the active turn without queuing', async () => {
  await withComposition(async (composition, store, bot, app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    await seedActiveTurn(composition, store, tempDir);

    await composition.telegramRouter.handleCommand(makeTextEvent('/guide Use the existing API'), 'en', 'guide', ['Use', 'the', 'existing', 'API']);

    assert.equal(store.countQueuedTurnInputs('chat-1'), 0);
    assert.equal(app.steerTurnCalls.length, 1);
    assert.equal(app.steerTurnCalls[0]?.turnId, 'turn-1');
    assert.equal(app.steerTurnCalls[0]?.input?.[0]?.text, 'Use the existing API');
    assert.match(bot.messages.at(-1)?.text ?? '', /Inserted your guidance into the current reply/);
  });
});

test('staged attachment batches are normalized before the follow-up message is queued', async () => {
  await withComposition(async (composition, store, bot, _app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    await seedActiveTurn(composition, store, tempDir);

    await composition.telegramRouter.handleText(makeTextEvent('Review this image', [makePhotoAttachment()]));
    assert.equal(store.countQueuedTurnInputs('chat-1'), 0);

    await composition.telegramRouter.handleText(makeTextEvent('Focus on the error banner'));

    const queued = store.peekQueuedTurnInput('chat-1');
    assert.ok(queued);
    const input = queued?.input as Array<Record<string, unknown>>;
    assert.equal(input[0]?.type, 'text');
    assert.equal(input[1]?.type, 'localImage');
    assert.equal(bot.downloads.length, 1);
    assert.ok(fs.existsSync(String(input[1]?.path)));
    assert.match(String(input[0]?.text ?? ''), /\.telegram-inbox/);
    assert.match(String(input[0]?.text ?? ''), /Current request:/);
  });
});

test('turn completion automatically starts the next queued message in FIFO order', async () => {
  await withComposition(async (composition, store, _bot, app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    await seedActiveTurn(composition, store, tempDir);

    await composition.telegramRouter.handleText(makeTextEvent('Queued one'));
    await composition.telegramRouter.handleText(makeTextEvent('Queued two'));

    const queuedRecords = store.listQueuedTurnInputs('chat-1').filter((record) => record.status === 'queued');
    assert.equal(queuedRecords.length, 2);

    await composition.turnExecution.handleTurnActivityEvent({ kind: 'turn_completed', turnId: 'turn-1', state: 'completed' });
    await waitFor(() => {
      assert.equal(app.startTurnCalls.length, 2);
      assert.equal(store.getQueuedTurnInput(queuedRecords[0]!.queueId)?.status, 'processing');
    });
    assert.equal(app.startTurnCalls[1]?.input?.[0]?.text, 'Queued one');

    await composition.turnExecution.handleTurnActivityEvent({ kind: 'turn_completed', turnId: 'turn-2', state: 'completed' });
    await waitFor(() => {
      assert.equal(app.startTurnCalls.length, 3);
      assert.equal(store.getQueuedTurnInput(queuedRecords[0]!.queueId)?.status, 'completed');
      assert.equal(store.getQueuedTurnInput(queuedRecords[1]!.queueId)?.status, 'processing');
    });
    assert.equal(app.startTurnCalls[2]?.input?.[0]?.text, 'Queued two');
  });
});

test('/stop retires stale local active turn when upstream has no active turn', async () => {
  await withComposition(async (composition, store, bot, app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    await seedActiveTurn(composition, store, tempDir);
    await composition.telegramRouter.handleText(makeTextEvent('Queued after stale turn'));

    app.interruptError = new Error('no active turn to interrupt');
    await composition.telegramRouter.handleCommand(makeTextEvent('/stop'), 'en', 'stop', []);

    assert.equal(app.interruptTurnCalls.length, 1);
    assert.ok(bot.messages.some((message) => /upstream turn was already gone/i.test(message.text)));
    await waitFor(() => {
      assert.equal(composition.activeTurns.findByScope('chat-1')?.turnId, 'turn-2');
      assert.equal(app.startTurnCalls.length, 2);
    });
    assert.equal(store.countQueuedTurnInputs('chat-1'), 0);
  });
});

test('queue command can clear queued messages', async () => {
  await withComposition(async (composition, store, bot, _app, tempDir) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    await seedActiveTurn(composition, store, tempDir);

    await composition.telegramRouter.handleText(makeTextEvent('Queued one'));
    await composition.telegramRouter.handleText(makeTextEvent('Queued two'));
    await composition.telegramRouter.handleCommand(makeTextEvent('/queue clear'), 'en', 'queue', ['clear']);

    assert.equal(store.countQueuedTurnInputs('chat-1'), 0);
    assert.match(bot.messages.at(-1)?.text ?? '', /Cleared queued messages: 2/);
  });
});
