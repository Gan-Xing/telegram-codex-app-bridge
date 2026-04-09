import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramScopeId, parseTelegramScopeId } from './scope.js';

test('scope id round-trips root chat scope', () => {
  const scopeId = createTelegramScopeId('-100123', null);
  assert.equal(scopeId, '-100123::root');
  assert.deepEqual(parseTelegramScopeId(scopeId), { chatId: '-100123', topicId: null });
});

test('scope id round-trips topic scope', () => {
  const scopeId = createTelegramScopeId('-100123', 42);
  assert.equal(scopeId, '-100123::42');
  assert.deepEqual(parseTelegramScopeId(scopeId), { chatId: '-100123', topicId: 42 });
});
