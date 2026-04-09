import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppThreadSnapshot } from '../types.js';
import { diffObservedTurn, findLatestTurn, findLiveTurn } from './observer.js';

test('findLiveTurn returns the latest in-progress turn', () => {
  const snapshot: AppThreadSnapshot = {
    threadId: 'thread-1',
    name: null,
    preview: 'preview',
    cwd: '/tmp/repo',
    modelProvider: 'openai',
    source: 'cli',
    path: '/tmp/repo/session.jsonl',
    status: 'active',
    updatedAt: 1,
    activeFlags: [],
    turns: [
      { turnId: 'turn-1', status: 'completed', error: null, items: [] },
      { turnId: 'turn-2', status: 'inProgress', error: null, items: [] },
    ],
  };

  assert.equal(findLiveTurn(snapshot)?.turnId, 'turn-2');
  assert.equal(findLatestTurn(snapshot)?.turnId, 'turn-2');
});

test('diffObservedTurn emits deltas and completion across snapshots', () => {
  const inProgressTurn = {
    turnId: 'turn-1',
    status: 'inProgress',
    error: null,
    items: [
      {
        itemId: 'item-1',
        type: 'agentMessage',
        phase: 'commentary',
        text: 'Checking CI',
        command: null,
        status: null,
        aggregatedOutput: null,
      },
    ],
  };

  const first = diffObservedTurn(null, inProgressTurn, false);
  assert.deepEqual(first.events.map((event) => event.kind), [
    'agent_message_started',
    'agent_message_delta',
  ]);

  const second = diffObservedTurn(first.nextCursor, {
    ...inProgressTurn,
    items: [{ ...inProgressTurn.items[0]!, text: 'Checking CI status' }],
  }, true);
  assert.deepEqual(second.events.map((event) => event.kind), ['agent_message_delta']);
  assert.equal(second.waitingOnApproval, true);

  const completed = diffObservedTurn(second.nextCursor, {
    ...inProgressTurn,
    status: 'completed',
    items: [{ ...inProgressTurn.items[0]!, text: 'Checking CI status' }],
  }, false);
  assert.equal(completed.completed, true);
  assert.deepEqual(completed.events.map((event) => event.kind), ['agent_message_completed']);
});

test('diffObservedTurn completes earlier commentary items once a later item appears', () => {
  const diff = diffObservedTurn(null, {
    turnId: 'turn-1',
    status: 'inProgress',
    error: null,
    items: [
      {
        itemId: 'item-1',
        type: 'agentMessage',
        phase: 'commentary',
        text: 'Looking at the workflow.',
        command: null,
        status: null,
        aggregatedOutput: null,
      },
      {
        itemId: 'item-2',
        type: 'agentMessage',
        phase: 'commentary',
        text: 'Fetching latest run status.',
        command: null,
        status: null,
        aggregatedOutput: null,
      },
    ],
  }, false);

  assert.deepEqual(diff.events.map((event) => event.kind), [
    'agent_message_started',
    'agent_message_delta',
    'agent_message_started',
    'agent_message_delta',
    'agent_message_completed',
  ]);
  assert.equal(diff.events.at(-1)?.kind, 'agent_message_completed');
});
