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
      messageId: null,
      createdAt: 123,
      resolvedAt: null,
    });

    assert.equal(store.countPendingApprovals(), 1);
    store.updatePendingApprovalMessage('approval-1', 99);
    assert.equal(store.getPendingApproval('approval-1')?.messageId, 99);
    store.markApprovalResolved('approval-1');
    assert.ok(store.getPendingApproval('approval-1')?.resolvedAt !== null);
    assert.equal(store.countPendingApprovals(), 0);
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
      updatedAt: store.getChatSettings('chat-3')!.updatedAt,
    });
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
