import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import type { EngineCapabilities } from '../engine/types.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramTextEvent } from '../telegram/gateway.js';
import { createBridgeComposition } from './composition.js';

function withComposition(run: (
  composition: ReturnType<typeof createBridgeComposition>,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
) => Promise<void>, options: {
  config?: Partial<AppConfig>;
  app?: ReturnType<typeof makeApp>;
} = {}): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-status-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const bot = makeBot();
  const composition = createBridgeComposition(
    makeConfig(tempDir, options.config),
    store,
    new Logger('error', path.join(tempDir, 'bridge.log')),
    bot as any,
    (options.app ?? makeApp()) as any,
  );
  return Promise.resolve(run(composition, store, bot)).finally(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
}

function makeConfig(tempDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
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
    ...overrides,
  };
}

function makeBot() {
  return {
    messages: [] as Array<{ chatId: string; text: string }>,
    async sendMessage(chatId: string, text: string) {
      this.messages.push({ chatId, text });
      return 101;
    },
    async sendHtmlMessage() { return 101; },
    async editMessage() {},
    async editHtmlMessage() {},
    async answerCallback() {},
    async clearMessageInlineKeyboard() {},
    async deleteMessage() {},
    async sendTypingInThread() {},
    async sendMessageDraft() {},
    async start() {},
    stop() {},
    username: 'bot',
  };
}

function makeApp(options: {
  capabilities?: Partial<EngineCapabilities> | null;
  readAccountRateLimits?: (() => Promise<any>) | null;
} = {}) {
  return {
    capabilities: options.capabilities ?? null,
    isConnected() {
      return true;
    },
    getUserAgent() {
      return 'test-agent';
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
      if (!options.readAccountRateLimits) {
        return {
          limitId: 'codex',
          limitName: null,
          primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1773082597 },
          secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1773531564 },
          credits: { hasCredits: false, unlimited: false, balance: '0' },
          planType: 'plus',
        };
      }
      return options.readAccountRateLimits();
    },
    getAccountRateLimits() {
      return null;
    },
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
    languageCode: 'zh',
  };
}

test('/status shows 5-hour and weekly rate limit usage', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'zh');
    composition.runtimeStatus.setSerializedLastError('Insufficient quota');
    store.savePendingAttachmentBatch({
      batchId: 'batch-1',
      scopeId: 'chat-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      mediaGroupId: null,
      noteText: '',
      attachments: [],
      receiptMessageId: null,
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
      resolvedAt: null,
    });

    await composition.telegramRouter.handleCommand(makeTextEvent('/status'), 'zh', 'status', []);

    const text = bot.messages[0]?.text ?? '';
    assert.match(text, /账号：ganxingus@gmail.com \(chatgpt, id:f2275ca4\)/);
    assert.match(text, /最近错误：Insufficient quota/);
    assert.match(text, /账户套餐：plus/);
    assert.match(text, /5小时额度：已用 37%/);
    assert.match(text, /本周额度：已用 81%/);
    assert.match(text, /待处理附件批次：1/);
  });
});

test('/status hides Codex-only sections for Gemini instances', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gemini-2.5-pro', 'medium', 'zh');
    store.setChatGeminiApprovalMode('chat-1', 'yolo');

    await composition.telegramRouter.handleCommand(makeTextEvent('/status'), 'zh', 'status', []);

    const text = bot.messages[0]?.text ?? '';
    assert.match(text, /引擎：Gemini CLI/);
    assert.match(text, /实例：glinux144-gemini/);
    assert.match(text, /已配置模型：gemini-2.5-pro/);
    assert.match(text, /模式：YOLO/);
    assert.doesNotMatch(text, /5小时额度：/);
    assert.doesNotMatch(text, /本周额度：/);
    assert.doesNotMatch(text, /已配置推理强度：/);
    assert.doesNotMatch(text, /已配置服务档位：/);
    assert.doesNotMatch(text, /审批策略：/);
    assert.doesNotMatch(text, /沙箱模式：/);
  }, {
    config: {
      bridgeEngine: 'gemini',
      bridgeInstanceId: 'glinux144-gemini',
    },
    app: makeApp({
      capabilities: {
        threads: true,
        reveal: false,
        guidedPlan: 'none',
        approvals: 'none',
        steerActiveTurn: false,
        rateLimits: false,
        reasoningEffort: false,
        serviceTier: false,
        reconnect: false,
      },
    }),
  });
});
