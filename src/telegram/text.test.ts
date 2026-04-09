import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkTelegramMessage, chunkTelegramStreamMessage, sanitizeTelegramPreview } from './text.js';

test('sanitizeTelegramPreview truncates long preview text', () => {
  const preview = sanitizeTelegramPreview('a'.repeat(4500));
  assert.equal(preview.length, 4000);
  assert.ok(preview.endsWith('...'));
});

test('chunkTelegramMessage keeps short messages intact', () => {
  assert.deepEqual(chunkTelegramMessage('hello'), ['hello']);
});

test('chunkTelegramMessage uses an empty list when fallback is blank', () => {
  assert.deepEqual(chunkTelegramMessage('', 4000, ''), []);
});

test('chunkTelegramMessage splits long messages near newline boundaries', () => {
  const input = `${'a'.repeat(2500)}\n${'b'.repeat(2500)}\n${'c'.repeat(2500)}`;
  const chunks = chunkTelegramMessage(input, 4000);

  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every(chunk => chunk.length <= 4000));
});

test('chunkTelegramStreamMessage prefers smaller stream chunks', () => {
  const input = `${'a'.repeat(900)}\n\n${'b'.repeat(900)}\n\n${'c'.repeat(900)}`;
  const chunks = chunkTelegramStreamMessage(input, 1200);

  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every(chunk => chunk.length <= 1200));
});
