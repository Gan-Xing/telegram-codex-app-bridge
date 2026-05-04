import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramIngressRouter } from './telegram_ingress.js';

function makeRouter(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ scopeId: string; text: string }> = [];
  let restartCalls = 0;
  const accounts = {
    async refreshPendingLogin() {
      return null;
    },
    async listAccounts() {
      return {
        accounts: [{
          id: 'acct-1',
          index: 1,
          label: 'Account 1',
          email: 'user@example.com',
          name: null,
          accountId: 'acc_123456789',
          plan: 'pro',
          planType: 'pro',
          credentialStore: 'encrypted-file',
          addedAt: Date.now(),
          lastUsedAt: Date.now(),
          isActive: true,
        }],
        activeAccountId: 'acct-1',
        pendingLogin: null,
      };
    },
    async cancelPendingLogin() {
      return false;
    },
    async switchAccountByIndex() {
      return {
        account: {
          id: 'acct-2',
          index: 2,
          label: 'Account 2',
          email: 'next@example.com',
          name: null,
          accountId: 'acc_987654321',
          plan: 'plus',
          planType: 'plus',
          credentialStore: 'encrypted-file',
          addedAt: Date.now(),
          lastUsedAt: Date.now(),
          isActive: true,
        },
        authPath: '/home/test/.codex/auth.json',
        refreshed: false,
      };
    },
  };
  const host = {
    config: {
      bridgeEngine: 'codex',
      tgAllowedChatId: null,
      tgAllowedTopicId: null,
      codexProviderProfiles: [],
    },
    turns: {
      count() {
        return 0;
      },
    },
    codexAccounts: accounts,
    async restartEngineAfterAccountSwitch() {
      restartCalls += 1;
    },
    messages: {
      async sendMessage(scopeId: string, text: string) {
        sent.push({ scopeId, text });
        return 1;
      },
    },
    providerCapabilities: {},
    ...overrides,
  };
  return {
    router: new TelegramIngressRouter(host as any),
    sent,
    accounts,
    get restartCalls() {
      return restartCalls;
    },
  };
}

const event = {
  scopeId: 'chat-1',
  chatId: 'chat-1',
  chatType: 'private',
  topicId: null,
  text: '/login',
  attachments: [],
  entities: [],
  replyToBot: false,
  languageCode: 'zh-CN',
};

test('/login list shows saved Codex accounts', async () => {
  const { router, sent } = makeRouter();

  await router.handleCommand(event as any, 'zh', 'login', ['list']);

  assert.equal(sent.length, 1);
  assert.match(sent[0]?.text ?? '', /Codex 账号池 \| 1 个账号/);
  assert.match(sent[0]?.text ?? '', /1\. user@example\.com \(pro, id:acc_1234\) \(当前\)/);
  assert.match(sent[0]?.text ?? '', /切换：\/login <序号>/);
});

test('/login <index> switches account and restarts Codex app-server', async () => {
  const context = makeRouter();

  await context.router.handleCommand(event as any, 'zh', 'login', ['2']);

  assert.equal(context.restartCalls, 1);
  assert.equal(context.sent.length, 1);
  assert.match(context.sent[0]?.text ?? '', /Codex 登录账号已切换/);
  assert.match(context.sent[0]?.text ?? '', /next@example\.com \(plus, id:acc_9876\)/);
  assert.match(context.sent[0]?.text ?? '', /已用当前账号重新连接 Codex app-server/);
});
