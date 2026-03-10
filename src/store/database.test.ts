import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeStore } from './database.js';

function withStore(run: (store: BridgeStore) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-store-'));
  const dbPath = path.join(tmpDir, 'bridge.sqlite');
  const store = new BridgeStore(dbPath);
  try {
    run(store);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('BridgeStore persists and resolves thread bindings', () => {
  withStore((store) => {
    store.setBinding('chat-1', 'thread-1', '/tmp/project');
    const binding = store.getBinding('chat-1');

    assert.ok(binding);
    assert.deepEqual(binding, {
      chatId: 'chat-1',
      threadId: 'thread-1',
      cwd: '/tmp/project',
      updatedAt: binding.updatedAt,
    });
    assert.equal(store.findChatIdByThreadId('thread-1'), 'chat-1');
    assert.equal(store.countBindings(), 1);
  });
});

test('BridgeStore caches thread lists and pending approvals', () => {
  withStore((store) => {
    store.cacheThreadList('chat-2', [
      {
        threadId: 'thread-a',
        name: 'Fix auth bug',
        preview: 'Fix auth bug',
        cwd: '/repo/a',
        modelProvider: 'openai',
        status: 'idle',
        updatedAt: 100,
      },
      {
        threadId: 'thread-b',
        name: null,
        preview: 'Review docs',
        cwd: null,
        modelProvider: null,
        status: 'active',
        updatedAt: 200,
      },
    ]);
    assert.deepEqual(store.getCachedThread('chat-2', 2), {
      index: 2,
      threadId: 'thread-b',
      name: null,
      preview: 'Review docs',
      cwd: null,
      modelProvider: null,
      status: 'active',
      updatedAt: 200,
    });
    assert.equal(store.listCachedThreads('chat-2').length, 2);

    store.savePendingApproval({
      localId: 'approval-1',
      serverRequestId: '42',
      kind: 'command',
      chatId: 'chat-2',
      threadId: 'thread-a',
      turnId: 'turn-1',
      itemId: 'item-1',
      approvalId: null,
      reason: 'Needs confirmation',
      command: 'rm -rf build',
      cwd: '/repo/a',
      summary: 'Delete build output',
      riskLevel: 'high',
      details: { commandPreview: 'rm -rf build' },
      messageId: null,
      createdAt: 123,
      resolvedAt: null,
    });

    assert.equal(store.countPendingApprovals(), 1);
    store.updatePendingApprovalMessage('approval-1', 99);
    assert.deepEqual(store.getPendingApproval('approval-1'), {
      localId: 'approval-1',
      serverRequestId: '42',
      kind: 'command',
      chatId: 'chat-2',
      threadId: 'thread-a',
      turnId: 'turn-1',
      itemId: 'item-1',
      approvalId: null,
      reason: 'Needs confirmation',
      command: 'rm -rf build',
      cwd: '/repo/a',
      summary: 'Delete build output',
      riskLevel: 'high',
      details: { commandPreview: 'rm -rf build' },
      messageId: 99,
      createdAt: 123,
      resolvedAt: null,
    });
    store.markApprovalResolved('approval-1');
    assert.ok(store.getPendingApproval('approval-1')?.resolvedAt !== null);
    assert.equal(store.countPendingApprovals(), 0);
  });
});

test('BridgeStore persists thread name overrides across cache refreshes', () => {
  withStore((store) => {
    store.cacheThreadList('chat-rename', [{
      threadId: 'thread-rename-1',
      name: 'Original name',
      preview: 'Original preview',
      cwd: '/repo/rename',
      modelProvider: 'openai',
      status: 'idle',
      updatedAt: 111,
    }]);
    store.setThreadNameOverride('chat-rename', 'thread-rename-1', 'Renamed thread');
    assert.equal(store.getThreadNameOverride('chat-rename', 'thread-rename-1'), 'Renamed thread');
    assert.equal(store.getCachedThread('chat-rename', 1)?.name, 'Renamed thread');

    store.cacheThreadList('chat-rename', [{
      threadId: 'thread-rename-1',
      name: 'Server-side name',
      preview: 'Updated preview',
      cwd: '/repo/rename',
      modelProvider: 'openai',
      status: 'idle',
      updatedAt: 222,
    }]);
    assert.equal(store.getCachedThread('chat-rename', 1)?.name, 'Renamed thread');
  });
});

test('BridgeStore persists pending user input progress', () => {
  withStore((store) => {
    store.savePendingUserInput({
      localId: 'input-1',
      serverRequestId: 'request-1',
      chatId: 'chat-2',
      threadId: 'thread-a',
      turnId: 'turn-1',
      itemId: 'item-1',
      messageId: null,
      questions: [
        {
          id: 'direction',
          header: 'Direction',
          question: 'Which direction should I take?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Keep current plan', description: 'Proceed with the current plan.' },
          ],
        },
      ],
      answers: {},
      currentQuestionIndex: 0,
      awaitingFreeText: false,
      createdAt: 456,
      resolvedAt: null,
    });

    assert.equal(store.countPendingUserInputs(), 1);
    assert.equal(store.getPendingUserInputForChat('chat-2')?.localId, 'input-1');

    store.updatePendingUserInputMessage('input-1', 77);
    store.updatePendingUserInputState('input-1', { direction: ['Keep current plan'] }, 1, true);

    assert.deepEqual(store.getPendingUserInput('input-1'), {
      localId: 'input-1',
      serverRequestId: 'request-1',
      chatId: 'chat-2',
      threadId: 'thread-a',
      turnId: 'turn-1',
      itemId: 'item-1',
      messageId: 77,
      questions: [
        {
          id: 'direction',
          header: 'Direction',
          question: 'Which direction should I take?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Keep current plan', description: 'Proceed with the current plan.' },
          ],
        },
      ],
      answers: { direction: ['Keep current plan'] },
      currentQuestionIndex: 1,
      awaitingFreeText: true,
      createdAt: 456,
      resolvedAt: null,
    });

    store.markPendingUserInputResolved('input-1');
    assert.equal(store.countPendingUserInputs(), 0);
  });
});

test('BridgeStore persists chat session settings', () => {
  withStore((store) => {
    store.setChatSettings('chat-3', 'o3', 'high');
    assert.deepEqual(store.getChatSettings('chat-3'), {
      chatId: 'chat-3',
      model: 'o3',
      reasoningEffort: 'high',
      locale: null,
      accessPreset: null,
      collaborationMode: null,
      confirmPlanBeforeExecute: true,
      autoQueueMessages: true,
      persistPlanHistory: true,
      updatedAt: store.getChatSettings('chat-3')!.updatedAt,
    });

    store.setChatSettings('chat-3', null, 'medium');
    assert.deepEqual(store.getChatSettings('chat-3'), {
      chatId: 'chat-3',
      model: null,
      reasoningEffort: 'medium',
      locale: null,
      accessPreset: null,
      collaborationMode: null,
      confirmPlanBeforeExecute: true,
      autoQueueMessages: true,
      persistPlanHistory: true,
      updatedAt: store.getChatSettings('chat-3')!.updatedAt,
    });

    store.setChatLocale('chat-3', 'zh');
    assert.deepEqual(store.getChatSettings('chat-3'), {
      chatId: 'chat-3',
      model: null,
      reasoningEffort: 'medium',
      locale: 'zh',
      accessPreset: null,
      collaborationMode: null,
      confirmPlanBeforeExecute: true,
      autoQueueMessages: true,
      persistPlanHistory: true,
      updatedAt: store.getChatSettings('chat-3')!.updatedAt,
    });

    store.setChatAccessPreset('chat-3', 'full-access');
    assert.deepEqual(store.getChatSettings('chat-3'), {
      chatId: 'chat-3',
      model: null,
      reasoningEffort: 'medium',
      locale: 'zh',
      accessPreset: 'full-access',
      collaborationMode: null,
      confirmPlanBeforeExecute: true,
      autoQueueMessages: true,
      persistPlanHistory: true,
      updatedAt: store.getChatSettings('chat-3')!.updatedAt,
    });

    store.setChatCollaborationMode('chat-3', 'plan');
    assert.deepEqual(store.getChatSettings('chat-3'), {
      chatId: 'chat-3',
      model: null,
      reasoningEffort: 'medium',
      locale: 'zh',
      accessPreset: 'full-access',
      collaborationMode: 'plan',
      confirmPlanBeforeExecute: true,
      autoQueueMessages: true,
      persistPlanHistory: true,
      updatedAt: store.getChatSettings('chat-3')!.updatedAt,
    });

    store.setChatGuidedPlanPreferences('chat-3', {
      confirmPlanBeforeExecute: false,
      autoQueueMessages: false,
    });
    assert.deepEqual(store.getChatSettings('chat-3'), {
      chatId: 'chat-3',
      model: null,
      reasoningEffort: 'medium',
      locale: 'zh',
      accessPreset: 'full-access',
      collaborationMode: 'plan',
      confirmPlanBeforeExecute: false,
      autoQueueMessages: false,
      persistPlanHistory: true,
      updatedAt: store.getChatSettings('chat-3')!.updatedAt,
    });

    store.setChatSettings('chat-3', 'o3', 'low');
    assert.deepEqual(store.getChatSettings('chat-3'), {
      chatId: 'chat-3',
      model: 'o3',
      reasoningEffort: 'low',
      locale: 'zh',
      accessPreset: 'full-access',
      collaborationMode: 'plan',
      confirmPlanBeforeExecute: false,
      autoQueueMessages: false,
      persistPlanHistory: true,
      updatedAt: store.getChatSettings('chat-3')!.updatedAt,
    });
  });
});

test('BridgeStore persists guided plan sessions, snapshots, queue, and prompt message history', () => {
  withStore((store) => {
    store.savePlanSession({
      sessionId: 'session-1',
      chatId: 'chat-5',
      threadId: 'thread-guided',
      sourceTurnId: 'turn-plan',
      executionTurnId: null,
      state: 'awaiting_plan_confirmation',
      confirmationRequired: true,
      confirmedPlanVersion: null,
      latestPlanVersion: 2,
      currentPromptId: null,
      currentApprovalId: null,
      queueDepth: 1,
      lastPlanMessageId: 12,
      lastPromptMessageId: null,
      lastApprovalMessageId: null,
      createdAt: 1000,
      updatedAt: 1001,
      resolvedAt: null,
    });

    store.savePlanSnapshot({
      sessionId: 'session-1',
      version: 1,
      sourceEvent: 'turn/plan/updated',
      explanation: 'First draft',
      steps: [
        { step: 'Inspect the repo', status: 'completed' },
        { step: 'Confirm the plan', status: 'pending' },
      ],
      createdAt: 1002,
    });

    store.saveQueuedTurnInput({
      queueId: 'queue-1',
      scopeId: 'chat-5::root',
      chatId: 'chat-5',
      threadId: 'thread-guided',
      input: [{ type: 'text', text: 'follow up' }],
      sourceSummary: 'follow up',
      telegramMessageId: 55,
      status: 'queued',
      createdAt: 1003,
      updatedAt: 1003,
    });

    store.savePendingUserInputMessage({
      inputLocalId: 'input-1',
      questionIndex: 0,
      messageId: 77,
      messageKind: 'question',
      createdAt: 1004,
    });

    assert.deepEqual(store.getPlanSession('session-1'), {
      sessionId: 'session-1',
      chatId: 'chat-5',
      threadId: 'thread-guided',
      sourceTurnId: 'turn-plan',
      executionTurnId: null,
      state: 'awaiting_plan_confirmation',
      confirmationRequired: true,
      confirmedPlanVersion: null,
      latestPlanVersion: 2,
      currentPromptId: null,
      currentApprovalId: null,
      queueDepth: 1,
      lastPlanMessageId: 12,
      lastPromptMessageId: null,
      lastApprovalMessageId: null,
      createdAt: 1000,
      updatedAt: 1001,
      resolvedAt: null,
    });
    assert.equal(store.listOpenPlanSessions('chat-5').length, 1);
    assert.deepEqual(store.listPlanSnapshots('session-1'), [{
      sessionId: 'session-1',
      version: 1,
      sourceEvent: 'turn/plan/updated',
      explanation: 'First draft',
      steps: [
        { step: 'Inspect the repo', status: 'completed' },
        { step: 'Confirm the plan', status: 'pending' },
      ],
      createdAt: 1002,
    }]);
    assert.deepEqual(store.peekQueuedTurnInput('chat-5::root'), {
      queueId: 'queue-1',
      scopeId: 'chat-5::root',
      chatId: 'chat-5',
      threadId: 'thread-guided',
      input: [{ type: 'text', text: 'follow up' }],
      sourceSummary: 'follow up',
      telegramMessageId: 55,
      status: 'queued',
      createdAt: 1003,
      updatedAt: 1003,
    });
    assert.equal(store.countQueuedTurnInputs('chat-5::root'), 1);
    assert.deepEqual(store.listPendingUserInputMessages('input-1'), [{
      inputLocalId: 'input-1',
      questionIndex: 0,
      messageId: 77,
      messageKind: 'question',
      createdAt: 1004,
    }]);

    store.updateQueuedTurnInputStatus('queue-1', 'processing');
    assert.equal(store.getQueuedTurnInput('queue-1')?.status, 'processing');
    assert.equal(store.countQueuedTurnInputs('chat-5::root'), 0);

    store.updatePlanSessionState('session-1', 'completed', 1005);
    assert.equal(store.getPlanSession('session-1')?.state, 'completed');
    assert.equal(store.getPlanSession('session-1')?.resolvedAt, 1005);
  });
});

test('BridgeStore persists active turn preview cleanup state', () => {
  withStore((store) => {
    store.saveActiveTurnPreview({
      turnId: 'turn-1',
      scopeId: 'chat-4::root',
      threadId: 'thread-1',
      messageId: 41,
    });

    let previews = store.listActiveTurnPreviews();
    assert.equal(previews.length, 1);
    assert.deepEqual(previews[0], {
      turnId: 'turn-1',
      scopeId: 'chat-4::root',
      threadId: 'thread-1',
      messageId: 41,
      createdAt: previews[0]!.createdAt,
      updatedAt: previews[0]!.updatedAt,
    });

    store.saveActiveTurnPreview({
      turnId: 'turn-2',
      scopeId: 'chat-4::root',
      threadId: 'thread-2',
      messageId: 42,
    });

    previews = store.listActiveTurnPreviews();
    assert.equal(previews.length, 1);
    assert.equal(previews[0]?.turnId, 'turn-2');
    assert.equal(previews[0]?.messageId, 42);

    store.removeActiveTurnPreviewByMessage('chat-4::root', 42);
    assert.deepEqual(store.listActiveTurnPreviews(), []);
  });
});

test('BridgeStore persists thread history preview state per scope', () => {
  withStore((store) => {
    store.saveThreadHistoryPreview({
      scopeId: 'chat-5::root',
      threadId: 'thread-1',
      messageId: 70,
    });

    let preview = store.getThreadHistoryPreview('chat-5::root');
    assert.deepEqual(preview, {
      scopeId: 'chat-5::root',
      threadId: 'thread-1',
      messageId: 70,
      createdAt: preview!.createdAt,
      updatedAt: preview!.updatedAt,
    });

    store.saveThreadHistoryPreview({
      scopeId: 'chat-5::root',
      threadId: 'thread-2',
      messageId: 71,
    });

    preview = store.getThreadHistoryPreview('chat-5::root');
    assert.equal(preview?.threadId, 'thread-2');
    assert.equal(preview?.messageId, 71);

    store.removeThreadHistoryPreview('chat-5::root');
    assert.equal(store.getThreadHistoryPreview('chat-5::root'), null);
  });
});

test('BridgeStore cleans up resolved history and respects plan history settings', () => {
  withStore((store) => {
    const now = Date.now();
    const recent = now - (1000 * 60 * 60 * 24 * 2);
    const expired = now - (1000 * 60 * 60 * 24 * 45);

    store.setChatSettings('chat-keep', 'gpt-5', 'medium', 'en');
    store.setChatSettings('chat-drop', 'gpt-5', 'medium', 'en');
    store.setChatGuidedPlanPreferences('chat-drop', { persistPlanHistory: false });

    const saveResolvedSession = (sessionId: string, chatId: string, resolvedAt: number) => {
      store.savePlanSession({
        sessionId,
        chatId,
        threadId: `thread-${chatId}`,
        sourceTurnId: `turn-${sessionId}`,
        executionTurnId: `exec-${sessionId}`,
        state: 'completed',
        confirmationRequired: true,
        confirmedPlanVersion: 1,
        latestPlanVersion: 1,
        currentPromptId: null,
        currentApprovalId: null,
        queueDepth: 0,
        lastPlanMessageId: null,
        lastPromptMessageId: null,
        lastApprovalMessageId: null,
        createdAt: resolvedAt - 100,
        updatedAt: resolvedAt,
        resolvedAt,
      });
      store.savePlanSnapshot({
        sessionId,
        version: 1,
        sourceEvent: 'turn/plan/updated',
        explanation: `Snapshot for ${sessionId}`,
        steps: [{ step: 'Do the work', status: 'completed' }],
        createdAt: resolvedAt - 50,
      });
    };

    saveResolvedSession('session-keep-new', 'chat-keep', recent);
    saveResolvedSession('session-keep-old', 'chat-keep', recent - 1000);
    saveResolvedSession('session-expired', 'chat-keep', expired);
    saveResolvedSession('session-drop', 'chat-drop', recent);

    store.savePendingApproval({
      localId: 'approval-old',
      serverRequestId: 'approval-request-old',
      kind: 'command',
      chatId: 'chat-keep',
      threadId: 'thread-chat-keep',
      turnId: 'turn-approval-old',
      itemId: 'item-approval-old',
      approvalId: null,
      reason: 'Old approval',
      command: 'rm -rf dist',
      cwd: '/repo',
      summary: 'Delete dist',
      riskLevel: 'high',
      details: null,
      messageId: null,
      createdAt: expired - 100,
      resolvedAt: expired,
    });
    store.savePendingApproval({
      localId: 'approval-open',
      serverRequestId: 'approval-request-open',
      kind: 'command',
      chatId: 'chat-keep',
      threadId: 'thread-chat-keep',
      turnId: 'turn-approval-open',
      itemId: 'item-approval-open',
      approvalId: null,
      reason: 'Open approval',
      command: 'npm test',
      cwd: '/repo',
      summary: 'Run tests',
      riskLevel: 'low',
      details: null,
      messageId: null,
      createdAt: recent,
      resolvedAt: null,
    });

    store.savePendingUserInput({
      localId: 'input-old',
      serverRequestId: 'request-old',
      chatId: 'chat-keep',
      threadId: 'thread-chat-keep',
      turnId: 'turn-input-old',
      itemId: 'item-input-old',
      messageId: null,
      questions: [],
      answers: {},
      currentQuestionIndex: 0,
      awaitingFreeText: false,
      createdAt: expired - 100,
      resolvedAt: expired,
    });
    store.savePendingUserInputMessage({
      inputLocalId: 'input-old',
      questionIndex: 0,
      messageId: 900,
      messageKind: 'resolved',
      createdAt: expired,
    });
    store.savePendingUserInput({
      localId: 'input-open',
      serverRequestId: 'request-open',
      chatId: 'chat-keep',
      threadId: 'thread-chat-keep',
      turnId: 'turn-input-open',
      itemId: 'item-input-open',
      messageId: null,
      questions: [],
      answers: {},
      currentQuestionIndex: 0,
      awaitingFreeText: false,
      createdAt: recent,
      resolvedAt: null,
    });

    store.saveQueuedTurnInput({
      queueId: 'queue-old',
      scopeId: 'chat-keep',
      chatId: 'chat-keep',
      threadId: 'thread-chat-keep',
      input: [{ type: 'text', text: 'Old follow up' }],
      sourceSummary: 'Old follow up',
      telegramMessageId: null,
      status: 'completed',
      createdAt: expired - 100,
      updatedAt: expired,
    });
    store.saveQueuedTurnInput({
      queueId: 'queue-live',
      scopeId: 'chat-keep',
      chatId: 'chat-keep',
      threadId: 'thread-chat-keep',
      input: [{ type: 'text', text: 'Live follow up' }],
      sourceSummary: 'Live follow up',
      telegramMessageId: null,
      status: 'queued',
      createdAt: recent,
      updatedAt: recent,
    });

    const result = store.cleanupHistoricalRecords({
      maxResolvedAgeMs: 1000 * 60 * 60 * 24 * 30,
      maxResolvedPlanSessionsPerChat: 1,
    });

    assert.deepEqual(result, {
      deletedPlanSessions: 3,
      deletedPlanSnapshots: 3,
      deletedPendingApprovals: 1,
      deletedPendingUserInputs: 1,
      deletedPendingUserInputMessages: 1,
      deletedQueuedTurnInputs: 1,
    });

    assert.ok(store.getPlanSession('session-keep-new'));
    assert.equal(store.getPlanSession('session-keep-old'), null);
    assert.equal(store.getPlanSession('session-expired'), null);
    assert.equal(store.getPlanSession('session-drop'), null);
    assert.equal(store.listPlanSnapshots('session-keep-new').length, 1);
    assert.equal(store.listPlanSnapshots('session-keep-old').length, 0);
    assert.equal(store.getPendingApproval('approval-old'), null);
    assert.equal(store.getPendingApproval('approval-open')?.resolvedAt, null);
    assert.equal(store.getPendingUserInput('input-old'), null);
    assert.deepEqual(store.listPendingUserInputMessages('input-old'), []);
    assert.equal(store.getPendingUserInput('input-open')?.resolvedAt, null);
    assert.equal(store.getQueuedTurnInput('queue-old'), null);
    assert.equal(store.getQueuedTurnInput('queue-live')?.status, 'queued');
  });
});
