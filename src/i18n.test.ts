import test from 'node:test';
import assert from 'node:assert/strict';
import { getTelegramCommands, normalizeLocale, t } from './i18n.js';

test('normalizeLocale maps telegram language codes', () => {
  assert.equal(normalizeLocale('zh-CN'), 'zh');
  assert.equal(normalizeLocale('zh-hans'), 'zh');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale(undefined), 'en');
});

test('getTelegramCommands returns localized descriptions', () => {
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'models')?.description, 'Model settings');
  assert.equal(getTelegramCommands('zh').find((entry) => entry.command === 'models')?.description, '模型设置');
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'watch')?.description, 'Watch the bound thread');
  assert.equal(getTelegramCommands('zh').find((entry) => entry.command === 'watch')?.description, '观察当前线程');
});

test('t interpolates localized templates', () => {
  assert.equal(t('en', 'bound_to_thread', { threadId: 'abc' }), 'Bound to thread abc');
  assert.equal(t('zh', 'bound_to_thread', { threadId: 'abc' }), '已绑定到线程 abc');
});
