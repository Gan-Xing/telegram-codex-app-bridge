import test from 'node:test';
import assert from 'node:assert/strict';
import { formatApprovalKinds, renderActiveTurnStatus } from './status.js';

test('interrupt status wins over all other activity states', () => {
  const text = renderActiveTurnStatus('en', {
    interruptRequested: true,
    pendingApprovalKinds: new Set(['command']),
    toolStatusText: 'Browsing 1 file',
    reasoningActive: true,
    hasStreamingReply: true,
  });
  assert.equal(text, 'Interrupt requested. Waiting for Codex to stop...');
});

test('approval status is rendered separately from thinking', () => {
  const text = renderActiveTurnStatus('zh', {
    interruptRequested: false,
    pendingApprovalKinds: new Set(['fileChange', 'command']),
    toolStatusText: null,
    reasoningActive: true,
    hasStreamingReply: false,
  });
  assert.equal(text, '需要审批：文件修改、命令执行');
});

test('streaming status is used when there is visible reply output', () => {
  const text = renderActiveTurnStatus('en', {
    interruptRequested: false,
    pendingApprovalKinds: new Set(),
    toolStatusText: null,
    reasoningActive: false,
    hasStreamingReply: true,
  });
  assert.equal(text, 'Streaming reply...');
});

test('approval kind formatter stays stable for both locales', () => {
  assert.equal(formatApprovalKinds('en', new Set(['command', 'fileChange'])), 'command, file change');
  assert.equal(formatApprovalKinds('zh', new Set(['command', 'fileChange'])), '命令执行、文件修改');
});
