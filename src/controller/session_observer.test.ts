import test from 'node:test';
import assert from 'node:assert/strict';
import { applySessionLog, bootstrapSessionLog, splitJsonlChunk } from './session_observer.js';

test('bootstrapSessionLog replays only the currently active turn', () => {
  const lines = [
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'done', phase: 'final_answer' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-2' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'OK' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Watching progress.', phase: 'commentary' },
    }),
  ];

  const bootstrap = bootstrapSessionLog(lines);
  assert.equal(bootstrap.startedTurnId, 'turn-2');
  assert.equal(bootstrap.cursor.activeTurnId, 'turn-2');
  assert.equal(bootstrap.cursor.nextMessageIndex, 1);
  assert.deepEqual(bootstrap.events.map(event => event.kind), [
    'user_message',
    'agent_message_started',
    'agent_message_delta',
    'agent_message_completed',
  ]);
});

test('applySessionLog emits tool and completion events for appended lines', () => {
  const diff = applySessionLog([
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: JSON.stringify({ cmd: 'sleep 10', workdir: '/tmp/repo' }),
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        call_id: 'call-1',
        turn_id: 'turn-2',
        command: ['/bin/bash', '-lc', 'sleep 10'],
        cwd: '/tmp/repo',
        parsed_cmd: [{ type: 'unknown', cmd: 'sleep 10' }],
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'done', phase: 'final_answer' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-2' },
    }),
  ], {
    activeTurnId: 'turn-2',
    nextMessageIndex: 1,
  });

  assert.deepEqual(diff.events.map(event => event.kind), [
    'tool_started',
    'tool_completed',
    'agent_message_started',
    'agent_message_delta',
    'agent_message_completed',
    'turn_completed',
  ]);
  assert.equal(diff.cursor.activeTurnId, null);
  assert.equal(diff.cursor.nextMessageIndex, 0);
});

test('splitJsonlChunk preserves incomplete trailing lines', () => {
  const split = splitJsonlChunk('', '{"a":1}\n{"b":2}');
  assert.deepEqual(split.lines, ['{"a":1}']);
  assert.equal(split.remainder, '{"b":2}');
});
