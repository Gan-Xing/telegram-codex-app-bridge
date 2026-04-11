import test from 'node:test';
import assert from 'node:assert/strict';
import { getTelegramCommands, normalizeLocale, t } from './i18n.js';

test('normalizeLocale maps telegram language codes', () => {
  assert.equal(normalizeLocale('zh-CN'), 'zh');
  assert.equal(normalizeLocale('zh-hans'), 'zh');
  assert.equal(normalizeLocale('fr-FR'), 'fr');
  assert.equal(normalizeLocale('fr-ca'), 'fr');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale(undefined), 'en');
});

test('getTelegramCommands returns localized descriptions', () => {
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'models')?.description, 'Model settings');
  assert.equal(getTelegramCommands('zh').find((entry) => entry.command === 'models')?.description, '模型设置');
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'tier')?.description, 'Service tier');
  assert.equal(getTelegramCommands('zh').find((entry) => entry.command === 'fast')?.description, '快档');
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'mode')?.description, 'Mode settings');
  assert.equal(getTelegramCommands('en').find((entry) => entry.command === 'reconnect')?.description, 'Reconnect Codex session');
  assert.equal(getTelegramCommands('zh').find((entry) => entry.command === 'restart')?.description, '重启桥接服务');
  assert.equal(getTelegramCommands('fr').find((entry) => entry.command === 'models')?.description, 'Parametres du modele');
  assert.equal(getTelegramCommands('fr').find((entry) => entry.command === 'restart')?.description, 'Redemarrer le bridge');
  assert.equal(getTelegramCommands('en', 'codex', { restart: false }).find((entry) => entry.command === 'restart'), undefined);
  assert.equal(getTelegramCommands('en', 'gemini').find((entry) => entry.command === 'threads')?.description, 'Recent threads');
  assert.equal(getTelegramCommands('en', 'gemini').find((entry) => entry.command === 'open')?.description, 'Open a cached thread');
  assert.equal(getTelegramCommands('en', 'gemini').find((entry) => entry.command === 'models')?.description, 'Model settings');
  assert.equal(getTelegramCommands('en', 'gemini').find((entry) => entry.command === 'mode')?.description, 'Mode settings');
  assert.equal(getTelegramCommands('zh', 'gemini').find((entry) => entry.command === 'interrupt')?.description, '中断当前回复');
});

test('t interpolates localized templates', () => {
  assert.equal(t('en', 'bound_to_thread', { threadId: 'abc' }), 'Bound to thread abc');
  assert.equal(t('zh', 'bound_to_thread', { threadId: 'abc' }), '已绑定到线程 abc');
  assert.equal(t('en', 'engine_codex'), 'Codex');
  assert.equal(t('zh', 'engine_gemini'), 'Gemini CLI');
  assert.equal(t('en', 'attachment_batch_resolved_started'), 'Started using these attachments with this bot.');
});
