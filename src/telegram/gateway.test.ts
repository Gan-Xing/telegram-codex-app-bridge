import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramGateway, type TelegramTextEvent } from './gateway.js';

const storeStub = {
  getTelegramOffset(): number {
    return 0;
  },
  setTelegramOffset(): void {},
};

const loggerStub = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

test('TelegramGateway emits media messages with caption and attachments', async () => {
  const gateway = new TelegramGateway('token', '42', null, 1000, storeStub as any, loggerStub as any);
  const events: TelegramTextEvent[] = [];
  gateway.on('text', (event: TelegramTextEvent) => {
    events.push(event);
  });

  await (gateway as any).handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      media_group_id: 'group-1',
      chat: { id: 99, type: 'private' },
      from: { id: 42, language_code: 'zh-CN' },
      caption: '看看这张图',
      photo: [
        { file_id: 'small', file_unique_id: 'unique-small', width: 90, height: 90, file_size: 1_000 },
        { file_id: 'large', file_unique_id: 'unique-large', width: 1280, height: 720, file_size: 2_000 },
      ],
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.text, '看看这张图');
  assert.equal(events[0]?.attachments.length, 1);
  assert.equal(events[0]?.mediaGroupId, 'group-1');
  assert.equal(events[0]?.scopeId, '99::root');
  assert.equal(events[0]?.topicId, null);
  assert.equal(events[0]?.replyToBot, false);
  assert.deepEqual(events[0]?.attachments[0], {
    kind: 'photo',
    fileId: 'large',
    fileUniqueId: 'unique-large',
    fileName: null,
    mimeType: 'image/jpeg',
    fileSize: 2_000,
    width: 1280,
    height: 720,
    durationSeconds: null,
    isAnimated: false,
    isVideo: false,
  });
  assert.equal(events[0]?.languageCode, 'zh-CN');
});

test('TelegramGateway emits document-only messages with empty text', async () => {
  const gateway = new TelegramGateway('token', '42', null, 1000, storeStub as any, loggerStub as any);
  const events: TelegramTextEvent[] = [];
  gateway.on('text', (event: TelegramTextEvent) => {
    events.push(event);
  });

  await (gateway as any).handleUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      chat: { id: 99, type: 'private' },
      from: { id: 42 },
      document: {
        file_id: 'doc-file',
        file_unique_id: 'doc-unique',
        file_name: 'report.pdf',
        mime_type: 'application/pdf',
        file_size: 3_000,
      },
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.text, '');
  assert.equal(events[0]?.mediaGroupId, null);
  assert.equal(events[0]?.attachments.length, 1);
  assert.equal(events[0]?.attachments[0]?.kind, 'document');
  assert.equal(events[0]?.attachments[0]?.fileName, 'report.pdf');
});

test('TelegramGateway emits topic messages for the configured group chat', async () => {
  const gateway = new TelegramGateway('token', '42', '-100123', 1000, storeStub as any, loggerStub as any);
  const events: TelegramTextEvent[] = [];
  gateway.on('text', (event: TelegramTextEvent) => {
    events.push(event);
  });
  (gateway as any).botUserId = 777;

  await (gateway as any).handleUpdate({
    update_id: 3,
    message: {
      message_id: 12,
      message_thread_id: 8,
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 42 },
      text: '@bot1 看下状态',
      entities: [{ type: 'mention', offset: 0, length: 5 }],
      reply_to_message: {
        message_id: 7,
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 777 },
        text: 'previous reply',
      },
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.scopeId, '-100123::8');
  assert.equal(events[0]?.mediaGroupId, null);
  assert.equal(events[0]?.chatType, 'supergroup');
  assert.equal(events[0]?.topicId, 8);
  assert.equal(events[0]?.replyToBot, true);
  assert.deepEqual(events[0]?.entities, [{ type: 'mention', offset: 0, length: 5 }]);
});

test('TelegramGateway still emits private chat messages when a group chat is configured', async () => {
  const gateway = new TelegramGateway('token', '42', '-100123', 1000, storeStub as any, loggerStub as any);
  const events: TelegramTextEvent[] = [];
  gateway.on('text', (event: TelegramTextEvent) => {
    events.push(event);
  });

  await (gateway as any).handleUpdate({
    update_id: 4,
    message: {
      message_id: 13,
      chat: { id: 99, type: 'private' },
      from: { id: 42 },
      text: '/help',
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.scopeId, '99::root');
  assert.equal(events[0]?.chatType, 'private');
  assert.equal(events[0]?.topicId, null);
});

test('TelegramGateway invalidates the previous polling session after stop/start', async () => {
  const gateway = new TelegramGateway('token', '42', null, 1000, storeStub as any, loggerStub as any);
  const pollSessionIds: number[] = [];
  (gateway as any).resolveBotIdentity = async () => {};
  (gateway as any).registerCommands = async () => {};
  (gateway as any).pollLoop = async (pollSessionId: number) => {
    pollSessionIds.push(pollSessionId);
  };

  await gateway.start();
  gateway.stop();
  await gateway.start();

  assert.deepEqual(pollSessionIds, [1, 3]);
});
