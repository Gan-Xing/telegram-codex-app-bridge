import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramMessageService } from './telegram_message_service.js';

test('TelegramMessageService retries sendMessage after retry_after and audits the delivered text', async () => {
  let attempts = 0;
  const auditEvents: Array<{ scopeId: string; eventType: string; summary: string }> = [];
  const service = new TelegramMessageService({
    async sendMessage() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('Too Many Requests: retry after 1');
      }
      return 101;
    },
    async sendHtmlMessage() {
      return 0;
    },
    async editMessage() {},
    async editHtmlMessage() {},
    async deleteMessage() {},
    async sendTypingInThread() {},
    async sendMessageDraft() {},
    async clearMessageInlineKeyboard() {},
  }, {
    audit: (_direction, scopeId, eventType, summary) => {
      auditEvents.push({ scopeId, eventType, summary });
    },
  });

  const startedAt = Date.now();
  const messageId = await service.sendMessage('chat-1', 'final answer');
  const elapsedMs = Date.now() - startedAt;

  assert.equal(messageId, 101);
  assert.equal(attempts, 2);
  assert.equal(auditEvents.length, 1);
  assert.deepEqual(auditEvents[0], {
    scopeId: 'chat-1',
    eventType: 'telegram.message',
    summary: 'final answer',
  });
  assert.ok(elapsedMs >= 900);
});

test('TelegramMessageService serializes sends within one scope', async () => {
  const callOrder: string[] = [];
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const service = new TelegramMessageService({
    async sendMessage(_chatId: string, text: string) {
      callOrder.push(`start:${text}`);
      if (text === 'first') {
        await firstPending;
      }
      callOrder.push(`end:${text}`);
      return text === 'first' ? 1 : 2;
    },
    async sendHtmlMessage() {
      return 0;
    },
    async editMessage() {},
    async editHtmlMessage() {},
    async deleteMessage() {},
    async sendTypingInThread() {},
    async sendMessageDraft() {},
    async clearMessageInlineKeyboard() {},
  });

  const first = service.sendMessage('chat-1', 'first');
  const second = service.sendMessage('chat-1', 'second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(callOrder, ['start:first']);

  releaseFirst();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(callOrder, ['start:first', 'end:first', 'start:second', 'end:second']);
});
