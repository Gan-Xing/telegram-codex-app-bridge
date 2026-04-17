import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CodexAppClient, mergeModelCatalog } from './client.js';
import { Logger } from '../logger.js';
import type { ModelInfo } from '../types.js';

test('mergeModelCatalog prepends overlay models and lets overlay defaults win', () => {
  const baseModels: ModelInfo[] = [
    {
      id: 'gpt-5.4',
      model: 'gpt-5.4',
      displayName: 'gpt-5.4',
      description: 'Base default',
      isDefault: true,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium',
    },
  ];
  const overlayModels: ModelInfo[] = [
    {
      id: 'MiniMax-M2.7',
      model: 'MiniMax-M2.7',
      displayName: 'MiniMax-M2.7',
      description: 'Overlay default',
      isDefault: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
    {
      id: 'MiniMax-M2.5',
      model: 'MiniMax-M2.5',
      displayName: 'MiniMax-M2.5',
      description: 'Overlay secondary',
      isDefault: false,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
  ];

  const merged = mergeModelCatalog(baseModels, overlayModels);
  assert.deepEqual(merged.map((model) => model.model), ['MiniMax-M2.7', 'MiniMax-M2.5', 'gpt-5.4']);
  assert.equal(merged[0]?.isDefault, true);
  assert.equal(merged[2]?.isDefault, false);
});

test('CodexAppClient can expose overlay-only model catalogs for non-native providers', async () => {
  const overlayModels: ModelInfo[] = [
    {
      id: 'MiniMax-M2.7',
      model: 'MiniMax-M2.7',
      displayName: 'MiniMax-M2.7',
      description: 'Overlay default',
      isDefault: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
    {
      id: 'MiniMax-M2.5',
      model: 'MiniMax-M2.5',
      displayName: 'MiniMax-M2.5',
      description: 'Overlay secondary',
      isDefault: false,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
  ];
  const client = new CodexAppClient(
    'codex',
    '',
    false,
    new Logger('error', path.join(os.tmpdir(), 'telegram-codex-client-test.log')),
    process.platform,
    overlayModels,
    'overlay-only',
  ) as any;
  client.request = async () => ({
    data: [{
      id: 'gpt-5.4',
      model: 'gpt-5.4',
      displayName: 'gpt-5.4',
      description: 'Base default',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      defaultReasoningEffort: 'medium',
    }],
    nextCursor: null,
  });

  const models = await client.listModels();
  assert.deepEqual(models.map((model: ModelInfo) => model.model), ['MiniMax-M2.7', 'MiniMax-M2.5']);
});

test('CodexAppClient serializes concurrent start requests for one profile runtime', async () => {
  const client = new CodexAppClient(
    'codex',
    '',
    false,
    new Logger('error', path.join(os.tmpdir(), 'telegram-codex-client-start-lock.test.log')),
    process.platform,
  ) as any;

  let startServerCalls = 0;
  let releaseStart!: () => void;
  client.startServer = async () => {
    startServerCalls += 1;
    await new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    client.connected = true;
  };

  const first = client.start();
  const second = client.start();
  assert.equal(startServerCalls, 1);
  releaseStart();
  await Promise.all([first, second]);
  assert.equal(startServerCalls, 1);
});

test('CodexAppClient sends an explicit default collaboration mode payload', async () => {
  const client = new CodexAppClient(
    'codex',
    '',
    false,
    new Logger('error', path.join(os.tmpdir(), 'telegram-codex-client-default-mode.test.log')),
    process.platform,
  ) as any;

  let requestPayload: any = null;
  client.request = async (_method: string, params: any) => {
    requestPayload = params;
    return { turn: { id: 'turn-1', status: 'running' } };
  };

  await client.startTurn({
    threadId: 'thread-1',
    input: [{ type: 'text', text: 'hello', text_elements: [] }],
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    cwd: '/tmp/demo',
    model: 'gpt-5.4',
    serviceTier: null,
    effort: 'medium',
    collaborationMode: 'default',
    developerInstructions: null,
  });

  assert.deepEqual(requestPayload?.collaborationMode, {
    mode: 'default',
    settings: {
      model: 'gpt-5.4',
      reasoning_effort: 'medium',
      developer_instructions: '',
    },
  });
});
