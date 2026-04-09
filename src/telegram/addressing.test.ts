import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../controller/commands.js';
import { isDefaultTelegramScope, resolveTelegramAddressing, type TelegramMessageEntity } from './addressing.js';

function mention(text: string): TelegramMessageEntity[] {
  return [{ type: 'mention', offset: 0, length: text.length }];
}

test('default topic accepts plain text without mention', () => {
  const decision = resolveTelegramAddressing({
    text: 'check docker status',
    attachmentsCount: 0,
    entities: [],
    command: null,
    botUsername: 'bot1',
    isDefaultTopic: true,
    replyToBot: false,
  });
  assert.deepEqual(decision, { kind: 'prompt', text: 'check docker status' });
});

test('non-default topic ignores plain text without mention', () => {
  const decision = resolveTelegramAddressing({
    text: 'check docker status',
    attachmentsCount: 0,
    entities: [],
    command: null,
    botUsername: 'bot1',
    isDefaultTopic: false,
    replyToBot: false,
  });
  assert.deepEqual(decision, { kind: 'ignore' });
});

test('non-default topic accepts leading mention and strips it', () => {
  const decision = resolveTelegramAddressing({
    text: '@bot1 check docker status',
    attachmentsCount: 0,
    entities: mention('@bot1'),
    command: null,
    botUsername: 'bot1',
    isDefaultTopic: false,
    replyToBot: false,
  });
  assert.deepEqual(decision, { kind: 'prompt', text: 'check docker status' });
});

test('reply to bot continues session outside default topic', () => {
  const decision = resolveTelegramAddressing({
    text: 'continue with nginx too',
    attachmentsCount: 0,
    entities: [],
    command: null,
    botUsername: 'bot1',
    isDefaultTopic: false,
    replyToBot: true,
  });
  assert.deepEqual(decision, { kind: 'prompt', text: 'continue with nginx too' });
});

test('non-default topic only accepts commands explicitly addressed to the bot', () => {
  const command = parseCommand('/status@bot1');
  assert.ok(command);
  const decision = resolveTelegramAddressing({
    text: '/status@bot1',
    attachmentsCount: 0,
    entities: [{ type: 'bot_command', offset: 0, length: 12 }],
    command,
    botUsername: 'bot1',
    isDefaultTopic: false,
    replyToBot: false,
  });
  assert.deepEqual(decision, { kind: 'command', command });
});

test('non-default topic ignores bare slash commands', () => {
  const command = parseCommand('/status');
  assert.ok(command);
  const decision = resolveTelegramAddressing({
    text: '/status',
    attachmentsCount: 0,
    entities: [{ type: 'bot_command', offset: 0, length: 7 }],
    command,
    botUsername: 'bot1',
    isDefaultTopic: false,
    replyToBot: false,
  });
  assert.deepEqual(decision, { kind: 'ignore' });
});

test('private chat is always treated as default scope', () => {
  assert.equal(isDefaultTelegramScope({
    chatType: 'private',
    allowedChatId: null,
    allowedTopicId: null,
    topicId: null,
  }), true);
});

test('allowed group without configured topic uses whole chat as default scope', () => {
  assert.equal(isDefaultTelegramScope({
    chatType: 'supergroup',
    allowedChatId: '-100123',
    allowedTopicId: null,
    topicId: 8,
  }), true);
});

test('allowed group with configured topic only treats that topic as default scope', () => {
  assert.equal(isDefaultTelegramScope({
    chatType: 'supergroup',
    allowedChatId: '-100123',
    allowedTopicId: 8,
    topicId: 8,
  }), true);
  assert.equal(isDefaultTelegramScope({
    chatType: 'supergroup',
    allowedChatId: '-100123',
    allowedTopicId: 8,
    topicId: 9,
  }), false);
});
