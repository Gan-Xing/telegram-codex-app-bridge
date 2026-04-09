import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeMessagingRouter } from '../bridge_messaging_router.js';
import type { TelegramMessagingPort } from '../telegram/telegram_messaging_port.js';
import type { WeixinMessagingPort } from './weixin_messaging_port.js';
import { accountFilePath, loadWeixinAccount, saveWeixinAccount, type WeixinSavedAccount } from './account_store.js';

function stubTelegram(): TelegramMessagingPort {
  return {
    sendPlain: async () => 1,
    sendHtml: async () => 2,
    editPlain: async () => {},
    editHtml: async () => {},
    deleteMessage: async () => {},
    sendTypingInScope: async () => {},
    clearInlineKeyboard: async () => {},
    sendDraft: async () => {},
    answerCallback: async () => {},
    getFile: async () => ({ file_id: '', file_path: '', file_size: 0 }) as any,
    downloadResolvedFile: async () => 0,
  } as unknown as TelegramMessagingPort;
}

test('BridgeMessagingRouter sends plain text via Weixin port for weixin scope', async () => {
  const tgCalls: string[] = [];
  const wxCalls: string[] = [];
  const tg = {
    ...stubTelegram(),
    sendPlain: async (scopeId: string, text: string) => {
      tgCalls.push(`${scopeId}:${text}`);
      return 10;
    },
  } as unknown as TelegramMessagingPort;
  const wx = {
    sendPlain: async (scopeId: string, text: string) => {
      wxCalls.push(`${scopeId}:${text}`);
      return 20;
    },
    sendHtml: async (scopeId: string, html: string) => wx.sendPlain(scopeId, html),
    editPlain: async () => {},
    editHtml: async () => {},
    deleteMessage: async () => {},
    sendTypingInScope: async () => {},
    clearInlineKeyboard: async () => {},
    sendDraft: async () => {},
  } as unknown as WeixinMessagingPort;
  const r = new BridgeMessagingRouter(tg, wx);
  const id = await r.sendPlain('weixin:acc1:user9', 'hello');
  assert.equal(id, 20);
  assert.deepEqual(wxCalls, ['weixin:acc1:user9:hello']);
  assert.equal(tgCalls.length, 0);
  const tid = await r.sendPlain('telegram:1::root', 't');
  assert.equal(tid, 10);
  assert.equal(tgCalls.length, 1);
});

test('saveWeixinAccount and loadWeixinAccount round-trip JSON shape', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-acc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rec: WeixinSavedAccount = {
    accountId: 'ilink-bot-9',
    botToken: 'tok',
    baseUrl: 'https://example.weixin.qq.com',
    linkedIlinkUserId: 'u1',
    savedAt: 1_700_000_000_000,
  };
  saveWeixinAccount(dir, rec);
  const fp = accountFilePath(dir, rec.accountId);
  assert.ok(fs.existsSync(fp));
  const loaded = loadWeixinAccount(dir, rec.accountId);
  assert.deepEqual(loaded, rec);
});
