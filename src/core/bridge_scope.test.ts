import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramScopeId } from '../telegram/scope.js';
import {
  BRIDGE_SCOPE_TELEGRAM_PREFIX,
  isBridgeScopedKey,
  parseTelegramTargetFromBridgeScope,
  parseWeixinBridgeScope,
  telegramInnerScopeFromBridge,
  toTelegramBridgeScopeId,
  toWeixinBridgeScopeId,
} from './bridge_scope.js';

test('toTelegramBridgeScopeId wraps inner telegram scope', () => {
  const inner = createTelegramScopeId('-100', 3);
  assert.equal(toTelegramBridgeScopeId(inner), `${BRIDGE_SCOPE_TELEGRAM_PREFIX}-100::3`);
});

test('parseTelegramTargetFromBridgeScope unwraps telegram prefix', () => {
  const id = toTelegramBridgeScopeId(createTelegramScopeId('42', null));
  assert.deepEqual(parseTelegramTargetFromBridgeScope(id), { chatId: '42', topicId: null });
});

test('telegramInnerScopeFromBridge returns null for non-telegram scopes', () => {
  assert.equal(telegramInnerScopeFromBridge('weixin:acc:peer'), null);
});

test('parseWeixinBridgeScope and toWeixinBridgeScopeId round-trip', () => {
  const id = toWeixinBridgeScopeId('bot1', 'user2');
  assert.equal(id, 'weixin:bot1:user2');
  assert.deepEqual(parseWeixinBridgeScope(id), { accountId: 'bot1', fromUserId: 'user2' });
  assert.equal(parseWeixinBridgeScope('telegram:x::y'), null);
});

test('isBridgeScopedKey recognizes weixin prefix', () => {
  assert.equal(isBridgeScopedKey('weixin:a:b'), true);
});
