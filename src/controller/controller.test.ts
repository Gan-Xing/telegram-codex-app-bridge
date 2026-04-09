import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../config.js';
import { BridgeMessagingRouter } from '../channels/bridge_messaging_router.js';
import { TelegramMessagingPort } from '../channels/telegram/telegram_messaging_port.js';
import { BridgeStore } from '../store/database.js';
import { BridgeController } from './controller.js';
import type { TelegramTextEvent } from '../telegram/gateway.js';

const loggerStub = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

function createConfig(tempDir: string): AppConfig {
  return {
    tgBotToken: 'token',
    tgAllowedUserId: '42',
    tgAllowedChatId: null,
    tgAllowedTopicId: null,
    codexCliBin: 'codex',
    codexAppAutolaunch: false,
    codexAppLaunchCmd: 'codex app',
    codexAppSyncOnOpen: false,
    codexAppSyncOnTurnComplete: false,
    storePath: path.join(tempDir, 'bridge.sqlite'),
    logLevel: 'error',
    defaultCwd: tempDir,
    defaultApprovalPolicy: 'never',
    defaultSandboxMode: 'danger-full-access',
    telegramPollIntervalMs: 1000,
    telegramPreviewThrottleMs: 0,
    threadListLimit: 10,
    statusPath: path.join(tempDir, 'status.json'),
    logPath: path.join(tempDir, 'bridge.log'),
    lockPath: path.join(tempDir, 'bridge.lock'),
    wxEnabled: false,
    wxAllowedIlinkUserIds: [],
    weixinAccountsDir: path.join(tempDir, 'weixin', 'accounts'),
    weixinSyncBufDir: path.join(tempDir, 'weixin', 'sync-buf'),
    weixinMediaDir: path.join(tempDir, 'weixin', 'media'),
    wxIlinkRouteTag: null,
  };
}

function createEvent(text: string): TelegramTextEvent {
  return {
    chatId: '99',
    topicId: null,
    scopeId: 'telegram:99::root',
    chatType: 'private',
    userId: '42',
    text,
    messageId: 1,
    attachments: [],
    entities: [],
    replyToBot: false,
  };
}

function createWeixinEvent(text: string): TelegramTextEvent {
  return {
    chatId: 'wx-user-1',
    topicId: null,
    scopeId: 'weixin:acc1:wx-user-1',
    chatType: 'private',
    userId: 'wx-user-1',
    text,
    messageId: 1,
    attachments: [],
    entities: [],
    replyToBot: false,
  };
}

function createControllerRig() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-controller-'));
  const store = new BridgeStore(path.join(tempDir, 'bridge.sqlite'));
  const sentMessages: string[] = [];
  const sentHtmlMessages: string[] = [];
  const deletedMessageIds: number[] = [];
  const bot = {
    sendMessage: async (_chatId: string, text: string) => {
      sentMessages.push(text);
      return sentMessages.length;
    },
    sendHtmlMessage: async (_chatId: string, text: string) => {
      sentHtmlMessages.push(text);
      return 1000 + sentHtmlMessages.length;
    },
    editMessage: async () => {},
    editHtmlMessage: async () => {},
    deleteMessage: async (_chatId: string, messageId: number) => {
      deletedMessageIds.push(messageId);
    },
    sendTypingInThread: async () => {},
    answerCallback: async () => {},
  };
  const weixinPort = {
    sendPlain: async (_scopeId: string, text: string) => {
      sentMessages.push(text);
      return sentMessages.length;
    },
    sendHtml: async (_scopeId: string, text: string) => {
      sentHtmlMessages.push(text);
      return 1000 + sentHtmlMessages.length;
    },
    editPlain: async () => {},
    editHtml: async () => {},
    deleteMessage: async () => {},
    sendTypingInScope: async () => {},
    clearInlineKeyboard: async () => {},
    sendDraft: async () => {},
  };
  const app = {
    isConnected: () => true,
    getUserAgent: () => 'test-agent',
  };
  const outbound = new BridgeMessagingRouter(new TelegramMessagingPort(bot as any), weixinPort as any);
  const controller = new BridgeController(createConfig(tempDir), store, loggerStub as any, bot as any, app as any, outbound);
  (controller as any).updateStatus = () => {};
  return { controller, store, sentMessages, sentHtmlMessages, deletedMessageIds, tempDir };
}

test('registerActiveTurn returns without waiting for turn completion', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  (rig.controller as any).queueTurnRender = async () => {};

  const pending = (rig.controller as any).registerActiveTurn('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  const result = await Promise.race([
    pending.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
  ]);

  assert.equal(result, 'resolved');
  const active = (rig.controller as any).activeTurns.get('turn-1');
  assert.ok(active);
  active.resolver();
});

test('takeover interrupts the active turn and starts a replacement turn after completion', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('telegram:99::root', 'thread-1', rig.tempDir);
  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);
  (rig.controller as any).queuedPrompts.set('telegram:99::root', { event: createEvent('/queue later'), text: 'later' });

  const calls: string[] = [];
  (rig.controller as any).requestInterrupt = async (turn: any) => {
    calls.push(`interrupt:${turn.turnId}`);
    turn.interruptRequested = true;
    setTimeout(() => {
      turn.resolver();
      (rig.controller as any).activeTurns.delete(turn.turnId);
    }, 0);
  };
  (rig.controller as any).stopWatchingScopeThread = async (scopeId: string) => {
    calls.push(`unwatch:${scopeId}`);
  };
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => {
    calls.push(`ready:${binding.threadId}`);
    return binding;
  };
  (rig.controller as any).sendTyping = async () => {
    calls.push('typing');
  };
  (rig.controller as any).buildTurnInput = async (_binding: any, inputEvent: TelegramTextEvent) => {
    calls.push(`build:${inputEvent.text}`);
    return [{ type: 'text', text: inputEvent.text, text_elements: [] }];
  };
  (rig.controller as any).startTurnWithRecovery = async (_scopeId: string, binding: any, input: Array<{ text: string }>) => {
    calls.push(`start:${binding.threadId}:${input[0]?.text}`);
    return { threadId: binding.threadId, turnId: 'turn-2' };
  };
  (rig.controller as any).registerActiveTurn = async (
    _scopeId: string,
    _chatId: string,
    _chatType: string,
    _topicId: number | null,
    threadId: string,
    turnId: string,
  ) => {
    calls.push(`register:${threadId}:${turnId}`);
  };

  await (rig.controller as any).handleCommand(createEvent('/takeover ship it'), 'en', 'takeover', ['ship', 'it']);

  assert.equal((rig.controller as any).queuedPrompts.size, 0);
  assert.deepEqual(calls, [
    'interrupt:turn-1',
    'unwatch:telegram:99::root',
    'ready:thread-1',
    'typing',
    'build:ship it',
    'start:thread-1:ship it',
    'register:thread-1:turn-2',
  ]);
  assert.ok(rig.sentMessages.includes('Interrupt requested. Waiting for Codex to stop...'));
});

test('queue stores the next prompt while a turn is active', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleCommand(createEvent('/queue first'), 'en', 'queue', ['first']);
  assert.equal((rig.controller as any).queuedPrompts.get('telegram:99::root')?.text, 'first');
  assert.equal(rig.sentMessages[0], 'Queued. I will send it after the current turn finishes.');

  await (rig.controller as any).handleCommand(createEvent('/queue second'), 'en', 'queue', ['second']);
  assert.equal((rig.controller as any).queuedPrompts.get('telegram:99::root')?.text, 'second');
  assert.equal(rig.sentMessages[1], 'Replaced the queued prompt. I will send the new one after the current turn finishes.');
});

test('completed turns automatically start a queued prompt', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0);
  (rig.controller as any).activeTurns.set('turn-1', active);
  (rig.controller as any).queuedPrompts.set('telegram:99::root', {
    event: createEvent('/queue continue'),
    text: 'continue',
  });
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};

  const started: Array<{ text: string; locale: string }> = [];
  (rig.controller as any).startBoundTurnFromEvent = async (_event: TelegramTextEvent, locale: string, text: string) => {
    started.push({ locale, text });
  };

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  assert.deepEqual(started, [{ locale: 'en', text: 'continue' }]);
  assert.equal((rig.controller as any).queuedPrompts.size, 0);
  assert.equal((rig.controller as any).activeTurns.size, 0);
});

test('watch relay sends codex cli user messages as prefixed telegram messages', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0, true);
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'user_message',
    turnId: 'turn-1',
    text: 'OK <check>',
  });

  assert.equal(rig.sentMessages.length, 0);
  assert.deepEqual(rig.sentHtmlMessages, [
    '<b>codex-cli-user</b>\n<pre>OK &lt;check&gt;</pre>',
  ]);
});

test('observed turns delete commentary and archived status messages after a final reply arrives', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState('telegram:99::root', '99', 'private', null, 'thread-1', 'turn-1', 0, true);
  active.finalText = 'done';
  active.segments = [
    {
      itemId: 'commentary-1',
      phase: 'commentary',
      outputKind: 'commentary',
      text: 'thinking',
      completed: true,
      messages: [{ messageId: 11, text: 'thinking' }],
    },
    {
      itemId: 'final-1',
      phase: 'final_answer',
      outputKind: 'final_answer',
      text: 'done',
      completed: true,
      messages: [{ messageId: 22, text: 'done' }],
    },
  ];
  active.archivedMessageIds = [33];
  (rig.controller as any).activeTurns.set('turn-1', active);
  (rig.controller as any).completeTurn = async () => {};
  (rig.controller as any).clearObservedTurnWatcher = () => {};

  await (rig.controller as any).handleTurnActivityEvent({
    kind: 'turn_completed',
    turnId: 'turn-1',
    state: 'completed',
  });

  assert.deepEqual(rig.deletedMessageIds, [11, 33]);
});

test('unwatch stops the current watcher and reports when nothing is being watched', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  (rig.controller as any).observedThreadWatchers.set('telegram:99::root', {
    scopeId: 'telegram:99::root',
    chatId: '99',
    chatType: 'private',
    topicId: null,
    threadId: 'thread-1',
    mode: 'session_file',
    timer: null,
    cursor: null,
    activeTurnId: null,
    waitingOnApproval: false,
    sessionPath: null,
    sessionOffset: -1,
    sessionRemainder: '',
    sessionCursor: { activeTurnId: null, nextMessageIndex: 0 },
    stopped: false,
  });

  await (rig.controller as any).handleCommand(createEvent('/unwatch'), 'en', 'unwatch', []);
  assert.equal((rig.controller as any).observedThreadWatchers.size, 0);
  assert.equal(rig.sentMessages[0], 'Stopped watching thread thread-1.');

  await (rig.controller as any).handleCommand(createEvent('/unwatch'), 'en', 'unwatch', []);
  assert.equal(rig.sentMessages[1], 'This chat is not watching any thread.');
});

test('weixin queue works like Telegram when a turn is active', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const active = (rig.controller as any).createActiveTurnState(
    'weixin:acc1:wx-user-1',
    'wx-user-1',
    'private',
    null,
    'thread-1',
    'turn-1',
    0,
  );
  (rig.controller as any).activeTurns.set('turn-1', active);

  await (rig.controller as any).handleCommand(createWeixinEvent('/queue next'), 'en', 'queue', ['next']);
  assert.equal((rig.controller as any).queuedPrompts.get('weixin:acc1:wx-user-1')?.text, 'next');
});

test('weixin takeover runs the same path as Telegram', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  rig.store.setBinding('weixin:acc1:wx-user-1', 'thread-1', rig.tempDir);
  const active = (rig.controller as any).createActiveTurnState(
    'weixin:acc1:wx-user-1',
    'wx-user-1',
    'private',
    null,
    'thread-1',
    'turn-1',
    0,
  );
  (rig.controller as any).activeTurns.set('turn-1', active);

  const calls: string[] = [];
  (rig.controller as any).requestInterrupt = async (turn: any) => {
    calls.push(`interrupt:${turn.turnId}`);
    turn.interruptRequested = true;
    setTimeout(() => {
      turn.resolver();
      (rig.controller as any).activeTurns.delete(turn.turnId);
    }, 0);
  };
  (rig.controller as any).stopWatchingScopeThread = async (scopeId: string) => {
    calls.push(`unwatch:${scopeId}`);
  };
  (rig.controller as any).ensureThreadReady = async (_scopeId: string, binding: any) => {
    calls.push(`ready:${binding.threadId}`);
    return binding;
  };
  (rig.controller as any).sendTyping = async () => {
    calls.push('typing');
  };
  (rig.controller as any).buildTurnInput = async (_binding: any, inputEvent: TelegramTextEvent) => {
    calls.push(`build:${inputEvent.text}`);
    return [{ type: 'text', text: inputEvent.text, text_elements: [] }];
  };
  (rig.controller as any).startTurnWithRecovery = async (_scopeId: string, binding: any, input: Array<{ text: string }>) => {
    calls.push(`start:${binding.threadId}:${input[0]?.text}`);
    return { threadId: binding.threadId, turnId: 'turn-2' };
  };
  (rig.controller as any).registerActiveTurn = async () => {
    calls.push('register');
  };

  await (rig.controller as any).handleCommand(createWeixinEvent('/takeover go'), 'en', 'takeover', ['go']);

  assert.ok(calls.includes('interrupt:turn-1'));
  assert.ok(calls.includes('unwatch:weixin:acc1:wx-user-1'));
});

test('weixin /permissions full-access persists access preset', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  const scope = 'weixin:acc1:wx-user-1';
  await (rig.controller as any).handleCommand(createWeixinEvent('/permissions full-access'), 'en', 'permissions', [
    'full-access',
  ]);
  assert.equal(rig.store.getChatSettings(scope)?.accessPreset, 'full-access');
  assert.ok(rig.sentMessages.some((m) => /full access/i.test(m)));
});

test('weixin /threads HTML message includes copy-paste /open lines', async (t) => {
  const rig = createControllerRig();
  t.after(() => {
    rig.store.close();
    fs.rmSync(rig.tempDir, { recursive: true, force: true });
  });

  (rig.controller as any).app.listThreads = async () => [
    {
      threadId: 't-wx-1',
      name: 'Wx thread',
      preview: 'hello',
      cwd: rig.tempDir,
      modelProvider: 'openai',
      source: 'cli',
      path: path.join(rig.tempDir, 't.jsonl'),
      status: 'idle',
      updatedAt: Math.floor(Date.now() / 1000),
    },
  ];

  await (rig.controller as any).handleText(createWeixinEvent('/threads'));

  assert.equal(rig.sentHtmlMessages.length, 1);
  const html = rig.sentHtmlMessages[0];
  assert.ok(html);
  assert.match(html, /\/open 1/);
  assert.match(html, /Copy-paste \(WeChat\):/);
});
