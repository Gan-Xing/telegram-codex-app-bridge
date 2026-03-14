import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import type { GuidedPlanSession } from '../types.js';
import { createBridgeComposition } from './composition.js';

function withComposition(run: (
  composition: ReturnType<typeof createBridgeComposition>,
  store: BridgeStore,
  bot: ReturnType<typeof makeBot>,
  app: ReturnType<typeof makeApp>,
) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-guided-plan-'));
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
  return Promise.resolve(run(composition, store, bot, app)).finally(async () => {
    await composition.turnLifecycle.abandonAllTurns();
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
    answered: [] as string[],
    edits: [] as Array<{ chatId: string; messageId: number; text: string; keyboard: unknown }>,
    htmlMessages: [] as Array<{ chatId: string; text: string; keyboard: unknown }>,
    typings: [] as Array<{ chatId: string; topicId: number | null | undefined }>,
    async answerCallback(_id: string, text: string) {
      this.answered.push(text);
    },
    async editHtmlMessage(chatId: string, messageId: number, text: string, keyboard?: unknown) {
      this.edits.push({ chatId, messageId, text, keyboard: keyboard ?? null });
    },
    async sendHtmlMessage(chatId: string, text: string, keyboard?: unknown, _topicId?: number | null) {
      this.htmlMessages.push({ chatId, text, keyboard: keyboard ?? null });
      nextMessageId += 1;
      return nextMessageId;
    },
    async sendMessage(_chatId: string, _text: string, _keyboard?: unknown, _topicId?: number | null) {
      nextMessageId += 1;
      return nextMessageId;
    },
    async sendTypingInThread(chatId: string, topicId?: number | null) {
      this.typings.push({ chatId, topicId });
    },
    async start() {},
    stop() {},
    username: 'bot',
  };
}

function makeApp() {
  return {
    startTurnCalls: [] as any[],
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
  };
}

function makePlanSession(): GuidedPlanSession {
  return {
    sessionId: 'session-1',
    chatId: 'chat-1',
    threadId: 'thread-1',
    sourceTurnId: 'turn-draft-1',
    executionTurnId: null,
    state: 'awaiting_plan_confirmation',
    confirmationRequired: true,
    confirmedPlanVersion: null,
    latestPlanVersion: 2,
    currentPromptId: 'prompt-1',
    currentApprovalId: null,
    queueDepth: 0,
    lastPlanMessageId: 10,
    lastPromptMessageId: 55,
    lastApprovalMessageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
  };
}

function makeCallbackEvent(messageId = 55): TelegramCallbackEvent {
  return {
    chatId: 'chat-1',
    topicId: null,
    scopeId: 'chat-1',
    userId: 'user-1',
    data: '',
    callbackQueryId: 'cb-1',
    messageId,
    languageCode: 'en',
  };
}

test('plan confirmation callback starts an execution turn on the same session', async () => {
  await withComposition(async (composition, store, bot, app) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setChatCollaborationMode('chat-1', 'plan');
    store.setBinding('chat-1', 'thread-1', '/tmp/demo');
    store.savePlanSession(makePlanSession());
    composition.attachedThreads.add('thread-1');

    await composition.guidedPlans.handlePlanSessionCallback(makeCallbackEvent(), 'session-1', 'confirm', 'en');

    const session = store.getPlanSession('session-1');
    assert.equal(session?.state, 'executing_confirmed_plan');
    assert.equal(session?.executionTurnId, 'turn-1');
    assert.equal(session?.confirmedPlanVersion, 2);
    assert.equal(bot.answered.at(-1), 'Execution started');
    assert.match(bot.edits.at(-1)?.text ?? '', /Plan decision recorded/);
    assert.match(app.startTurnCalls[0]?.developerInstructions ?? '', /The user confirmed the latest plan\./);
    assert.equal(composition.activeTurns.get('turn-1')?.guidedPlanDraftOnly, false);
  });
});

test('plan confirmation callback can execute from a visible plan card without a structured snapshot', async () => {
  await withComposition(async (composition, store, bot, app) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setChatCollaborationMode('chat-1', 'plan');
    store.setBinding('chat-1', 'thread-1', '/tmp/demo');
    store.savePlanSession({
      ...makePlanSession(),
      latestPlanVersion: null,
    });
    composition.attachedThreads.add('thread-1');

    await composition.guidedPlans.handlePlanSessionCallback(makeCallbackEvent(), 'session-1', 'confirm', 'en');

    const session = store.getPlanSession('session-1');
    assert.equal(session?.state, 'executing_confirmed_plan');
    assert.equal(session?.executionTurnId, 'turn-1');
    assert.equal(session?.confirmedPlanVersion, null);
    assert.equal(bot.answered.at(-1), 'Execution started');
    assert.match(bot.edits.at(-1)?.text ?? '', /Confirm and execute this plan/);
    assert.match(app.startTurnCalls[0]?.developerInstructions ?? '', /The user confirmed the latest plan\./);
  });
});

test('plan confirmation callback cancels the pending session without starting a turn', async () => {
  await withComposition(async (composition, store, bot, app) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setChatCollaborationMode('chat-1', 'plan');
    store.savePlanSession(makePlanSession());

    await composition.guidedPlans.handlePlanSessionCallback(makeCallbackEvent(), 'session-1', 'cancel', 'en');

    const session = store.getPlanSession('session-1');
    assert.equal(session?.state, 'cancelled');
    assert.ok(session?.resolvedAt);
    assert.equal(app.startTurnCalls.length, 0);
    assert.equal(bot.answered.at(-1), 'Plan cancelled');
    assert.match(bot.edits.at(-1)?.text ?? '', /Cancel the plan/);
  });
});

test('plan notifications persist semantic snapshots and stream draft deltas into one card', async () => {
  await withComposition(async (composition, store, bot) => {
    store.setChatSettings('chat-1', 'gpt-5', 'medium', 'en');
    store.setChatCollaborationMode('chat-1', 'plan');
    store.setBinding('chat-1', 'thread-1', '/tmp/demo');
    store.savePlanSession({
      ...makePlanSession(),
      state: 'drafting_plan',
      latestPlanVersion: null,
      confirmedPlanVersion: null,
      lastPlanMessageId: null,
      lastPromptMessageId: null,
    });

    composition.activeTurns.set('turn-1', {
      scopeId: 'chat-1',
      chatId: 'chat-1',
      topicId: null,
      renderRoute: { conversationKind: 'private_chat', preferredRenderer: 'segmented_stream', currentRenderer: 'segmented_stream', supportsDraftStreaming: true, usesMessageThread: false },
      threadId: 'thread-1',
      turnId: 'turn-1',
      previewMessageId: 0,
      previewActive: false,
      draftId: null,
      draftText: null,
      buffer: '',
      finalText: null,
      completionState: 'completed',
      completionStatusText: null,
      completionErrorText: null,
      interruptRequested: false,
      statusMessageText: null,
      statusNeedsRebase: false,
      segments: [],
      reasoningActiveCount: 0,
      pendingApprovalKinds: new Set(),
      pendingUserInputId: null,
      toolBatch: null,
      pendingArchivedStatus: null,
      planMessageId: null,
      planText: null,
      planExplanation: null,
      planSteps: [],
      planDraftText: null,
      planLastRenderedAt: 0,
      planRenderRequested: false,
      forcePlanRender: false,
      planRenderTask: null,
      guidedPlanSessionId: 'session-1',
      guidedPlanDraftOnly: true,
      guidedPlanExecutionBlocked: false,
      renderRetryTimer: null,
      lastStreamFlushAt: 0,
      renderRequested: false,
      forceStatusFlush: false,
      forceStreamFlush: false,
      renderTask: null,
      queuedInputId: null,
      resolver: () => {},
    });

    await composition.turnExecution.syncTurnPlan(composition.activeTurns.get('turn-1') as any, {
      turnId: 'turn-1',
      explanation: 'Inspect the repository first.',
      plan: [
        { step: 'Inspect controller flow', status: 'inProgress' },
        { step: 'Patch Telegram bridge', status: 'pending' },
      ],
    });

    const firstSnapshots = store.listPlanSnapshots('session-1');
    assert.equal(firstSnapshots.length, 1);
    assert.equal(firstSnapshots[0]?.version, 1);
    assert.match(bot.htmlMessages[0]?.text ?? '', /Current version: 1/);

    await composition.turnExecution.syncTurnPlan(composition.activeTurns.get('turn-1') as any, {
      turnId: 'turn-1',
      explanation: 'Inspect the repository first.',
      plan: [
        { step: 'Inspect controller flow', status: 'inProgress' },
        { step: 'Patch Telegram bridge', status: 'pending' },
      ],
    });

    assert.equal(store.listPlanSnapshots('session-1').length, 1);

    await composition.codexRouter.handleNotification({
      method: 'item/plan/delta',
      params: {
        turnId: 'turn-1',
        itemId: 'plan-item-1',
        delta: 'Refining the second step with more detail.',
      },
    });

    assert.match(bot.edits.at(-1)?.text ?? '', /Updating plan\.\.\./);
    assert.match(bot.edits.at(-1)?.text ?? '', /Refining the second step with more detail\./);

    await composition.turnExecution.syncTurnPlan(composition.activeTurns.get('turn-1') as any, {
      turnId: 'turn-1',
      explanation: 'Inspect the repository first, then patch carefully.',
      plan: [
        { step: 'Inspect controller flow', status: 'completed' },
        { step: 'Patch Telegram bridge', status: 'inProgress' },
      ],
    });

    const finalSnapshots = store.listPlanSnapshots('session-1');
    assert.equal(finalSnapshots.length, 2);
    assert.equal(finalSnapshots[1]?.version, 2);
    assert.equal(store.getPlanSession('session-1')?.latestPlanVersion, 2);
    assert.match(bot.edits.at(-1)?.text ?? '', /Current version: 2/);
    assert.doesNotMatch(bot.edits.at(-1)?.text ?? '', /Updating plan\.\.\./);
  });
});
