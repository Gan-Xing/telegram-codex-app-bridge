import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../config.js';
import { Logger } from '../logger.js';
import { createOpenCodeEngineProvider } from './opencode_provider.js';

function makeConfig(): Pick<
  AppConfig,
  'opencodeCliBin' | 'opencodeDefaultModel' | 'opencodeDefaultAgent' | 'opencodeServerHostname' | 'opencodeServerPort' | 'defaultCwd'
> {
  const tempDir = path.join(os.tmpdir(), 'telegram-opencode-provider-test');
  return {
    opencodeCliBin: 'opencode',
    opencodeDefaultModel: null,
    opencodeDefaultAgent: 'build',
    opencodeServerHostname: '127.0.0.1',
    opencodeServerPort: 4096,
    defaultCwd: tempDir,
  };
}

function makeActiveTurn() {
  return {
    turnId: 'turn-1',
    threadId: 'session-1',
    itemId: 'item-1',
    reasoningItemId: 'reasoning-1',
    cwd: '/tmp/project',
    model: null,
    assistantStarted: false,
    reasoningCompleted: false,
    completed: false,
    interrupted: false,
    pendingError: null,
    assistantMessageId: 'assistant-message-1',
    assistantPartOrder: [],
    assistantPartKinds: new Map(),
    assistantPartTexts: new Map(),
    emittedAssistantText: '',
    toolStates: new Map(),
  };
}

test('opencode provider ignores reasoning deltas when building assistant output', () => {
  const provider = createOpenCodeEngineProvider(
    makeConfig(),
    new Logger('error', path.join(os.tmpdir(), 'telegram-opencode-provider-test.log')),
  );
  const providerAny = provider as any;
  const active = makeActiveTurn();
  const notifications: any[] = [];
  provider.on('notification', (notification) => {
    notifications.push(notification);
  });

  providerAny.activeTurns.set(active.turnId, active);
  providerAny.activeTurnBySession.set(active.threadId, active.turnId);

  providerAny.handlePartUpdated({
    id: 'reason-part',
    sessionID: active.threadId,
    messageID: active.assistantMessageId,
    type: 'reasoning',
    text: '',
    time: { start: 1 },
  });
  providerAny.handlePartDelta({
    sessionID: active.threadId,
    messageID: active.assistantMessageId,
    partID: 'reason-part',
    field: 'text',
    delta: 'The user is greeting me in Chinese.',
  });

  assert.deepEqual(active.assistantPartOrder, []);
  assert.equal(active.assistantPartTexts.size, 0);
  assert.equal(
    notifications.some((notification) => JSON.stringify(notification).includes('The user is greeting me in Chinese')),
    false,
  );

  providerAny.handlePartUpdated({
    id: 'text-part',
    sessionID: active.threadId,
    messageID: active.assistantMessageId,
    type: 'text',
    text: '',
    time: { start: 2 },
  });
  providerAny.handlePartDelta({
    sessionID: active.threadId,
    messageID: active.assistantMessageId,
    partID: 'text-part',
    field: 'text',
    delta: '你好！有什么可以帮助你的吗？',
  });

  assert.deepEqual(active.assistantPartOrder, ['text-part']);
  assert.equal(active.assistantPartTexts.get('text-part'), '你好！有什么可以帮助你的吗？');

  const agentDeltas = notifications
    .filter((notification) => notification.method === 'item/agentMessage/delta')
    .map((notification) => notification.params?.delta);
  assert.deepEqual(agentDeltas, ['你好！有什么可以帮助你的吗？']);
});

test('opencode provider ignores user message parts while an active turn is running', () => {
  const provider = createOpenCodeEngineProvider(
    makeConfig(),
    new Logger('error', path.join(os.tmpdir(), 'telegram-opencode-provider-test.log')),
  );
  const providerAny = provider as any;
  const active = makeActiveTurn();
  const notifications: any[] = [];
  provider.on('notification', (notification) => {
    notifications.push(notification);
  });

  providerAny.activeTurns.set(active.turnId, active);
  providerAny.activeTurnBySession.set(active.threadId, active.turnId);

  providerAny.handlePartUpdated({
    id: 'user-text-part',
    sessionID: active.threadId,
    messageID: 'user-message-1',
    type: 'text',
    text: '还有，还是不对哦，我发现我发的信息，你都会再给我发回来，这样可不对',
    time: { start: 1 },
  });
  providerAny.handlePartDelta({
    sessionID: active.threadId,
    messageID: 'user-message-1',
    partID: 'user-text-part',
    field: 'text',
    delta: '还有，还是不对哦，我发现我发的信息，你都会再给我发回来，这样可不对',
  });

  assert.deepEqual(active.assistantPartOrder, []);
  assert.equal(active.assistantPartTexts.size, 0);
  assert.equal(notifications.length, 0);
});

test('opencode provider strips leading meta narration from assistant text parts', () => {
  const provider = createOpenCodeEngineProvider(
    makeConfig(),
    new Logger('error', path.join(os.tmpdir(), 'telegram-opencode-provider-test.log')),
  );
  const providerAny = provider as any;
  const active = makeActiveTurn();
  const notifications: any[] = [];
  provider.on('notification', (notification) => {
    notifications.push(notification);
  });

  providerAny.activeTurns.set(active.turnId, active);
  providerAny.activeTurnBySession.set(active.threadId, active.turnId);

  providerAny.handlePartUpdated({
    id: 'text-part',
    sessionID: active.threadId,
    messageID: active.assistantMessageId,
    type: 'text',
    text: '',
    time: { start: 1 },
  });
  providerAny.handlePartDelta({
    sessionID: active.threadId,
    messageID: active.assistantMessageId,
    partID: 'text-part',
    field: 'text',
    delta: 'The user is greeting me in Chinese ("你好？" means "Hello?").\nI should respond concisely as per my instructions.',
  });

  assert.equal(
    notifications.some((notification) => notification.method === 'item/agentMessage/delta'),
    false,
  );
  assert.equal(active.emittedAssistantText, '');

  providerAny.handlePartDelta({
    sessionID: active.threadId,
    messageID: active.assistantMessageId,
    partID: 'text-part',
    field: 'text',
    delta: '\n你好！有什么可以帮助你的吗？',
  });

  const agentDeltas = notifications
    .filter((notification) => notification.method === 'item/agentMessage/delta')
    .map((notification) => notification.params?.delta);
  assert.deepEqual(agentDeltas, ['你好！有什么可以帮助你的吗？']);
  assert.equal(active.emittedAssistantText, '你好！有什么可以帮助你的吗？');
});

test('opencode provider suppresses noisy tool start events for read and search tools', () => {
  const provider = createOpenCodeEngineProvider(
    makeConfig(),
    new Logger('error', path.join(os.tmpdir(), 'telegram-opencode-provider-test.log')),
  );
  const providerAny = provider as any;
  const active = makeActiveTurn();
  const notifications: any[] = [];
  provider.on('notification', (notification) => {
    notifications.push(notification);
  });

  providerAny.updateToolPart(active, {
    id: 'tool-part-1',
    type: 'tool',
    sessionID: active.threadId,
    messageID: active.assistantMessageId,
    callID: 'call-1',
    tool: 'grep',
    state: {
      status: 'running',
      input: { query: 'hello', path: 'src' },
    },
  });
  providerAny.updateToolPart(active, {
    id: 'tool-part-1',
    type: 'tool',
    sessionID: active.threadId,
    messageID: active.assistantMessageId,
    callID: 'call-1',
    tool: 'grep',
    state: {
      status: 'completed',
      input: { query: 'hello', path: 'src' },
    },
  });

  assert.deepEqual(
    notifications.map((notification) => notification.method),
    ['codex/event/exec_command_end'],
  );
});

test('opencode provider creates sessions with permission rules at thread creation time', async () => {
  const provider = createOpenCodeEngineProvider(
    makeConfig(),
    new Logger('error', path.join(os.tmpdir(), 'telegram-opencode-provider-test.log')),
  );
  const providerAny = provider as any;
  const createCalls: Array<{ directory: string; title: string | null | undefined; permission: unknown; parentID: string | null | undefined }> = [];
  let updateCalled = false;

  providerAny.client = {
    createSession: async (directory: string, title?: string | null, permission?: unknown, parentID?: string | null) => {
      createCalls.push({ directory, title, permission, parentID });
      return {
        id: 'session-1',
        slug: 'session-1',
        directory,
        title: 'session-1',
        permission,
        time: { created: 1, updated: 1 },
      };
    },
    updateSession: async () => {
      updateCalled = true;
      throw new Error('updateSession should not be called when creating threads');
    },
  };
  providerAny.ensureSessionRecord = async (session: any) => ({
    session,
    preview: '',
    model: null,
    modelProvider: null,
    status: 'idle',
  });

  const session = await provider.startThread({
    cwd: '/tmp/project',
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    model: null,
    serviceTier: null,
  });

  assert.equal(updateCalled, false);
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0], {
    directory: '/tmp/project',
    title: null,
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    parentID: undefined,
  });
  assert.equal(session.thread.threadId, 'session-1');
});

test('opencode provider recreates session when existing permission rules do not match', async () => {
  const provider = createOpenCodeEngineProvider(
    makeConfig(),
    new Logger('error', path.join(os.tmpdir(), 'telegram-opencode-provider-test.log')),
  );
  const providerAny = provider as any;
  const createCalls: Array<{ directory: string; title: string | null | undefined; permission: unknown; parentID: string | null | undefined }> = [];
  const promptCalls: Array<{ sessionId: string; body: Record<string, unknown>; directory: string | null | undefined }> = [];

  providerAny.requireSessionRecord = async () => ({
    session: {
      id: 'session-old',
      slug: 'session-old',
      directory: '/tmp/project',
      title: 'old title',
      permission: null,
      time: { created: 1, updated: 1 },
    },
    preview: 'old preview',
    model: 'minimax/MiniMax-M2.7',
    modelProvider: 'minimax',
    status: 'idle',
  });
  providerAny.client = {
    getSession: async () => ({
      id: 'session-old',
      slug: 'session-old',
      directory: '/tmp/project',
      title: 'old title',
      permission: null,
      time: { created: 1, updated: 2 },
    }),
    createSession: async (directory: string, title?: string | null, permission?: unknown, parentID?: string | null) => {
      createCalls.push({ directory, title, permission, parentID });
      return {
        id: 'session-new',
        slug: 'session-new',
        directory,
        title: title ?? 'session-new',
        permission,
        time: { created: 3, updated: 3 },
      };
    },
    promptAsync: async (sessionId: string, body: Record<string, unknown>, directory?: string | null) => {
      promptCalls.push({ sessionId, body, directory });
    },
  };
  providerAny.ensureSessionRecord = async (session: any) => ({
    session,
    preview: '',
    model: null,
    modelProvider: null,
    status: 'idle',
  });

  const result = await provider.startTurn({
    threadId: 'session-old',
    input: [{ type: 'text', text: 'hello', text_elements: [] }],
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    cwd: '/tmp/project',
    model: null,
    serviceTier: null,
    effort: null,
    collaborationMode: null,
    developerInstructions: null,
  });

  assert.equal(result.threadId, 'session-new');
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0], {
    directory: '/tmp/project',
    title: 'old title',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    parentID: 'session-old',
  });
  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0]?.sessionId, 'session-new');
  assert.equal(providerAny.activeTurns.get(result.id)?.threadId, 'session-new');
});

test('opencode provider lists reasoning efforts from model variants', async () => {
  const provider = createOpenCodeEngineProvider(
    makeConfig(),
    new Logger('error', path.join(os.tmpdir(), 'telegram-opencode-provider-test.log')),
  );
  const providerAny = provider as any;
  providerAny.client = {
    listProviders: async () => ({
      default: { cliproxy: 'gpt-5' },
      providers: [
        {
          id: 'cliproxy',
          name: 'CLIProxyAPI',
          models: {
            'gpt-5': {
              id: 'gpt-5',
              name: 'GPT-5',
              providerID: 'cliproxy',
              capabilities: { reasoning: true },
              variants: {
                none: {},
                minimal: {},
                low: {},
                medium: {},
                high: {},
                xhigh: {},
              },
            },
            'claude-opus-4-6-thinking': {
              id: 'claude-opus-4-6-thinking',
              name: 'Claude Opus 4.6 Thinking',
              providerID: 'cliproxy',
              capabilities: { reasoning: true },
              variants: {
                high: {},
                max: {},
              },
            },
          },
        },
      ],
    }),
  };

  const models = await provider.listModels();
  const gpt5 = models.find((entry) => entry.model === 'cliproxy/gpt-5');
  const claude = models.find((entry) => entry.model === 'cliproxy/claude-opus-4-6-thinking');

  assert.deepEqual(gpt5?.supportedReasoningEfforts, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(gpt5?.defaultReasoningEffort, 'medium');
  assert.deepEqual(gpt5?.supportedVariants, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(claude?.supportedReasoningEfforts, ['high']);
  assert.equal(claude?.defaultReasoningEffort, 'high');
  assert.deepEqual(claude?.supportedVariants, ['high', 'max']);
});

test('opencode provider passes reasoning effort as variant when supported by the model', async () => {
  const provider = createOpenCodeEngineProvider(
    makeConfig(),
    new Logger('error', path.join(os.tmpdir(), 'telegram-opencode-provider-test.log')),
  );
  const providerAny = provider as any;
  const promptCalls: Array<{ sessionId: string; body: Record<string, unknown>; directory: string | null | undefined }> = [];

  providerAny.modelsCache = {
    default: { cliproxy: 'gpt-5' },
    providers: [
      {
        id: 'cliproxy',
        name: 'CLIProxyAPI',
        models: {
          'gpt-5': {
            id: 'gpt-5',
            name: 'GPT-5',
            providerID: 'cliproxy',
            capabilities: { reasoning: true },
            variants: {
              low: {},
              medium: {},
              high: {},
            },
          },
        },
      },
    ],
  };
  providerAny.requireSessionRecord = async () => ({
    session: {
      id: 'session-1',
      slug: 'session-1',
      directory: '/tmp/project',
      title: 'session-1',
      permission: [{ permission: '*', pattern: '*', action: 'allow' }],
      time: { created: 1, updated: 1 },
    },
    preview: '',
    model: 'cliproxy/gpt-5',
    modelProvider: 'cliproxy',
    status: 'idle',
  });
  providerAny.ensureSessionPermission = async (record: any) => record;
  providerAny.client = {
    promptAsync: async (sessionId: string, body: Record<string, unknown>, directory?: string | null) => {
      promptCalls.push({ sessionId, body, directory });
    },
  };

  await provider.startTurn({
    threadId: 'session-1',
    input: [{ type: 'text', text: 'hello', text_elements: [] }],
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    cwd: '/tmp/project',
    model: 'cliproxy/gpt-5',
    serviceTier: null,
    effort: 'high',
    collaborationMode: null,
    developerInstructions: null,
  });

  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0]?.body.variant, 'high');
});

test('opencode provider prefers explicit model variant over reasoning effort', async () => {
  const provider = createOpenCodeEngineProvider(
    makeConfig(),
    new Logger('error', path.join(os.tmpdir(), 'telegram-opencode-provider-test.log')),
  );
  const providerAny = provider as any;
  const promptCalls: Array<{ body: Record<string, unknown> }> = [];

  providerAny.modelsCache = {
    default: { cliproxy: 'gpt-5' },
    providers: [
      {
        id: 'cliproxy',
        name: 'CLIProxyAPI',
        models: {
          'gpt-5': {
            id: 'gpt-5',
            name: 'GPT-5',
            providerID: 'cliproxy',
            capabilities: { reasoning: true },
            variants: {
              medium: { reasoningEffort: 'medium' },
              high: { reasoningEffort: 'high' },
              max: { reasoningEffort: 'high' },
            },
          },
        },
      },
    ],
  };
  providerAny.requireSessionRecord = async () => ({
    session: {
      id: 'session-1',
      slug: 'session-1',
      directory: '/tmp/project',
      title: 'session-1',
      permission: [{ permission: '*', pattern: '*', action: 'allow' }],
      time: { created: 1, updated: 1 },
    },
    preview: '',
    model: 'cliproxy/gpt-5',
    modelProvider: 'cliproxy',
    status: 'idle',
  });
  providerAny.ensureSessionPermission = async (record: any) => record;
  providerAny.client = {
    promptAsync: async (_sessionId: string, body: Record<string, unknown>) => {
      promptCalls.push({ body });
    },
  };

  await provider.startTurn({
    threadId: 'session-1',
    input: [{ type: 'text', text: 'hello', text_elements: [] }],
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    cwd: '/tmp/project',
    model: 'cliproxy/gpt-5',
    serviceTier: null,
    effort: 'high',
    modelVariant: 'max',
    collaborationMode: null,
    developerInstructions: null,
  });

  assert.equal(promptCalls[0]?.body.variant, 'max');
});
