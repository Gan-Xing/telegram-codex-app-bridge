import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPendingUserInputResponse,
  renderAnsweredPendingUserInputMessage,
  renderCancelledPendingUserInputMessage,
  renderPendingUserInputMessage,
  renderPendingUserInputReviewMessage,
  renderResolvedPendingUserInputMessage,
} from './approval_input.js';
import {
  renderPlanConfirmationMessage,
  renderResolvedPlanConfirmationMessage,
} from './guided_plan.js';
import type { GuidedPlanSession, PendingUserInputRecord } from '../types.js';

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
  assert.equal(rendered.keyboard[4]?.[0]?.text, 'Cancel');
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

test('renderPendingUserInputReviewMessage summarizes answers and exposes submit plus edit actions', () => {
  const record = {
    ...makeRecord(),
    questions: [
      ...makeRecord().questions,
      {
        id: 'risk',
        header: 'Risk level',
        question: 'How aggressive should the change be?',
        isOther: false,
        isSecret: false,
        options: null,
      },
    ],
    answers: {
      direction: ['Minimal patch'],
      risk: ['Low risk only'],
    },
    currentQuestionIndex: 2,
  };
  const rendered = renderPendingUserInputReviewMessage('en', record);

  assert.match(rendered.html, /Review answers/);
  assert.match(rendered.html, /Answer: Minimal patch/);
  assert.match(rendered.html, /Answer: Low risk only/);
  assert.equal(rendered.keyboard[0]?.[0]?.text, 'Submit');
  assert.equal(rendered.keyboard[0]?.[1]?.text, 'Cancel');
  assert.match(rendered.keyboard[1]?.[0]?.text ?? '', /Edit: Choose direction/);
});

test('renderCancelledPendingUserInputMessage shows a terminal cancellation state', () => {
  const html = renderCancelledPendingUserInputMessage('zh', makeRecord());

  assert.match(html, /已取消本次提问/);
  assert.match(html, /线程：thread-1/);
});

function makePlanSession(): GuidedPlanSession {
  return {
    sessionId: 'session-1',
    chatId: 'chat-1',
    threadId: 'thread-1',
    sourceTurnId: 'turn-1',
    executionTurnId: null,
    state: 'awaiting_plan_confirmation',
    confirmationRequired: true,
    confirmedPlanVersion: null,
    latestPlanVersion: 3,
    currentPromptId: 'prompt-1',
    currentApprovalId: null,
    queueDepth: 0,
    lastPlanMessageId: 11,
    lastPromptMessageId: 22,
    lastApprovalMessageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
  };
}

test('renderPlanConfirmationMessage offers continue as the recommended option', () => {
  const rendered = renderPlanConfirmationMessage('en', makePlanSession(), { blockedExecution: true });

  assert.match(rendered.html, /Review this plan/);
  assert.match(rendered.html, /Plan version: 3/);
  assert.match(rendered.html, /Execution was blocked because planning tried to move past review before you confirmed\./);
  assert.equal(rendered.keyboard[0]?.[0]?.text, 'Recommended: Confirm & execute');
  assert.equal(rendered.keyboard[1]?.[0]?.text, 'Revise');
  assert.equal(rendered.keyboard[1]?.[1]?.text, 'Cancel');
});

test('renderPlanConfirmationMessage still allows confirmation when only the visible plan card exists', () => {
  const rendered = renderPlanConfirmationMessage('zh', {
    ...makePlanSession(),
    latestPlanVersion: null,
  });

  assert.match(rendered.html, /可以直接确认并执行/);
  assert.equal(rendered.keyboard[0]?.[0]?.text, '推荐: 确认并执行');
});

test('renderPlanConfirmationMessage hides confirm when no plan was rendered at all', () => {
  const rendered = renderPlanConfirmationMessage('zh', {
    ...makePlanSession(),
    latestPlanVersion: null,
    lastPlanMessageId: null,
  });

  assert.match(rendered.html, /当前还没有可确认的结构化计划/);
  assert.equal(rendered.keyboard.length, 1);
  assert.equal(rendered.keyboard[0]?.[0]?.text, '修改计划');
});

test('renderResolvedPlanConfirmationMessage summarizes the recorded decision', () => {
  const html = renderResolvedPlanConfirmationMessage('en', makePlanSession(), 'confirm');

  assert.match(html, /Plan decision recorded/);
  assert.match(html, /Decision: Confirm and execute this plan/);
});
