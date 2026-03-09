import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPendingUserInputResponse,
  renderAnsweredPendingUserInputMessage,
  renderPendingUserInputMessage,
  renderResolvedPendingUserInputMessage,
} from './controller.js';
import type { PendingUserInputRecord } from '../types.js';

function makeRecord(): PendingUserInputRecord {
  return {
    localId: 'local-1',
    serverRequestId: 'request-1',
    chatId: 'chat-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    messageId: 42,
    questions: [
      {
        id: 'direction',
        header: 'Choose direction',
        question: 'Which path should Codex take first?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Minimal patch', description: 'Use the smallest safe change.' },
          { label: 'Broader cleanup', description: 'Refactor related code while touching it.' },
          { label: 'Delay for more research', description: 'Inspect more files before changing code.' },
        ],
      },
    ],
    answers: {},
    currentQuestionIndex: 0,
    awaitingFreeText: false,
    createdAt: Date.now(),
    resolvedAt: null,
  };
}

test('renderPendingUserInputMessage highlights the first option as recommended', () => {
  const record = makeRecord();
  const question = record.questions[0]!;
  const rendered = renderPendingUserInputMessage('en', record, question);

  assert.match(rendered.html, /1\. Recommended: Minimal patch - Use the smallest safe change\./);
  assert.match(rendered.html, /Choose one option below, or tap Other to send a custom answer\./);
  assert.equal(rendered.keyboard[0]?.[0]?.text, 'Recommended: Minimal patch');
  assert.equal(rendered.keyboard[3]?.[0]?.text, 'Other');
});

test('renderAnsweredPendingUserInputMessage summarizes the selected answer for the current step', () => {
  const record = makeRecord();
  const question = record.questions[0]!;
  const html = renderAnsweredPendingUserInputMessage('zh', record, question, ['最小补丁']);

  assert.match(html, /已记录答案/);
  assert.match(html, /<b>Choose direction \(1\/1\)<\/b>/);
  assert.match(html, /答案：最小补丁/);
});

test('buildPendingUserInputResponse keeps answer arrays grouped by question id', () => {
  assert.deepEqual(buildPendingUserInputResponse({
    direction: ['Minimal patch'],
    follow_up: ['Use buttons first'],
  }), {
    direction: { answers: ['Minimal patch'] },
    follow_up: { answers: ['Use buttons first'] },
  });
});

test('renderResolvedPendingUserInputMessage lists resolved answers for each question', () => {
  const record = makeRecord();
  const html = renderResolvedPendingUserInputMessage('en', record, {
    direction: ['Minimal patch'],
  });

  assert.match(html, /Answer recorded/);
  assert.match(html, /<b>Choose direction<\/b>/);
  assert.match(html, /Answer: Minimal patch/);
});
