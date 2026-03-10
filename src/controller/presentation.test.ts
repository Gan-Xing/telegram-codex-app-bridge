import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAccessSettingsKeyboard,
  buildModeSettingsKeyboard,
  buildModelSettingsKeyboard,
  buildSettingsHomeKeyboard,
  buildThreadsKeyboard,
  clampEffortToModel,
  formatAccessSettingsMessage,
  formatAccessPresetLabel,
  formatApprovalPolicyLabel,
  formatCollaborationModeLabel,
  formatModeSettingsMessage,
  formatModelSettingsMessage,
  formatSettingsHomeMessage,
  formatSandboxModeLabel,
  formatThreadsMessage,
  normalizeRequestedEffort,
  resolveRequestedModel,
} from './presentation.js';
import type { AppThread, ChatSessionSettings, ModelInfo } from '../types.js';

test('formatThreadsMessage highlights current thread and metadata', () => {
  const threads: AppThread[] = [
    {
      threadId: 'thread-1',
      name: 'Fix Telegram bridge',
      preview: 'Split long replies and clean previews',
      cwd: '/tmp/project',
      modelProvider: 'openai',
      status: 'idle',
      updatedAt: Math.floor(Date.now() / 1000) - 120,
    },
  ];

  const rendered = formatThreadsMessage('en', threads, 'thread-1');
  assert.match(rendered, /<b>Recent threads<\/b>/);
  assert.match(rendered, /Tap a button below to open or rename a thread/);
  assert.match(rendered, /Current: <b>Fix Telegram bridge<\/b>/);
  assert.match(rendered, /project \| 2m ago/);
});

test('formatThreadsMessage escapes html and shows filter', () => {
  const threads: AppThread[] = [
    {
      threadId: 'thread-2',
      name: 'Review <auth> flow',
      preview: 'Review <auth> flow',
      cwd: '/tmp/repo',
      modelProvider: 'openai',
      status: 'active',
      updatedAt: Math.floor(Date.now() / 1000) - 30,
    },
  ];

  const rendered = formatThreadsMessage('en', threads, null, 'auth <bug>');
  assert.match(rendered, /Filter: <code>auth &lt;bug&gt;<\/code>/);
  assert.doesNotMatch(rendered, /Review <auth> flow/);
});

test('buildThreadsKeyboard creates open and rename buttons per thread', () => {
  const threads: AppThread[] = [
    {
      threadId: 'thread-2',
      name: 'Review auth flow',
      preview: 'Review auth flow',
      cwd: '/tmp/repo',
      modelProvider: 'openai',
      status: 'active',
      updatedAt: Math.floor(Date.now() / 1000) - 30,
    },
  ];

  assert.deepEqual(buildThreadsKeyboard('en', threads), [[
    {
      text: '1. Review auth flow',
      callback_data: 'thread:open:thread-2',
    },
    {
      text: 'Rename',
      callback_data: 'thread:rename:start:thread-2',
    },
  ]]);
});

test('formatModelSettingsMessage renders current selections', () => {
  const models: ModelInfo[] = [
    {
      id: 'model-o3',
      model: 'o3',
      displayName: 'OpenAI o3',
      description: 'Reasoning model',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
  ];
  const settings: ChatSessionSettings = {
    chatId: 'chat-1',
    model: 'o3',
    reasoningEffort: 'high',
    locale: 'en',
    accessPreset: null,
    collaborationMode: null,
    confirmPlanBeforeExecute: true,
    autoQueueMessages: true,
    persistPlanHistory: true,
    updatedAt: Date.now(),
  };

  const rendered = formatModelSettingsMessage('en', models, settings);
  assert.match(rendered, /<b>Model settings<\/b>/);
  assert.match(rendered, /Model: <b>o3<\/b>/);
  assert.match(rendered, /Effort: <b>high<\/b>/);
  assert.match(rendered, /Supported efforts: <code>medium, high<\/code>/);
});

test('buildModelSettingsKeyboard marks selected model and effort', () => {
  const models: ModelInfo[] = [
    {
      id: 'model-o3',
      model: 'o3',
      displayName: 'OpenAI o3',
      description: 'Reasoning model',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
    {
      id: 'model-o4-mini',
      model: 'o4-mini',
      displayName: 'OpenAI o4-mini',
      description: 'Fast model',
      isDefault: false,
      supportedReasoningEfforts: ['low', 'medium'],
      defaultReasoningEffort: 'medium',
    },
  ];
  const settings: ChatSessionSettings = {
    chatId: 'chat-1',
    model: 'o3',
    reasoningEffort: 'high',
    locale: 'en',
    accessPreset: null,
    collaborationMode: null,
    confirmPlanBeforeExecute: true,
    autoQueueMessages: true,
    persistPlanHistory: true,
    updatedAt: Date.now(),
  };

  const keyboard = buildModelSettingsKeyboard('en', models, settings);
  assert.deepEqual(keyboard[0], [
    { text: 'Auto', callback_data: 'settings:model:default' },
    { text: '• o3', callback_data: 'settings:model:o3' },
  ]);
  assert.deepEqual(keyboard[1], [
    { text: 'o4-mini', callback_data: 'settings:model:o4-mini' },
  ]);
  assert.equal(keyboard.at(-2)?.at(-1)?.text, '• high');
  assert.equal(keyboard.at(-1)?.[0]?.text, 'Settings');
});

test('resolveRequestedModel matches model ids and display names', () => {
  const models: ModelInfo[] = [
    {
      id: 'model-o3',
      model: 'o3',
      displayName: 'OpenAI o3',
      description: 'Reasoning model',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
  ];

  assert.equal(resolveRequestedModel(models, 'o3')?.model, 'o3');
  assert.equal(resolveRequestedModel(models, 'OpenAI o3')?.model, 'o3');
  assert.equal(resolveRequestedModel(models, 'missing'), null);
});

test('clampEffortToModel falls back to model default when unsupported', () => {
  const model: ModelInfo = {
    id: 'model-o4-mini',
    model: 'o4-mini',
    displayName: 'OpenAI o4-mini',
    description: 'Fast model',
    isDefault: false,
    supportedReasoningEfforts: ['low', 'medium'],
    defaultReasoningEffort: 'medium',
  };

  assert.deepEqual(clampEffortToModel(model, 'high'), {
    effort: 'medium',
    adjustedFrom: 'high',
  });
  assert.deepEqual(clampEffortToModel(model, 'low'), {
    effort: 'low',
    adjustedFrom: null,
  });
});

test('normalizeRequestedEffort validates allowed effort names', () => {
  assert.equal(normalizeRequestedEffort('HIGH'), 'high');
  assert.equal(normalizeRequestedEffort('invalid'), null);
});

test('access presentation renders current preset and marks selected option', () => {
  const access = {
    preset: 'full-access' as const,
    approvalPolicy: 'never' as const,
    sandboxMode: 'danger-full-access' as const,
  };

  const rendered = formatAccessSettingsMessage('en', access);
  assert.match(rendered, /<b>Access settings<\/b>/);
  assert.match(rendered, /Preset: <b>Full access<\/b>/);
  assert.match(rendered, /Approval policy: <b>Never ask<\/b>/);
  assert.match(rendered, /Sandbox: <b>Danger full access<\/b>/);

  assert.deepEqual(buildAccessSettingsKeyboard('en', access), [[
    { text: 'Read-only', callback_data: 'settings:access:read-only' },
    { text: 'Default', callback_data: 'settings:access:default' },
    { text: '• Full access', callback_data: 'settings:access:full-access' },
  ], [
    { text: 'Settings', callback_data: 'settings:home' },
  ]]);
});

test('access labels render in chinese locale', () => {
  assert.equal(formatAccessPresetLabel('zh', 'read-only'), '只读');
  assert.equal(formatApprovalPolicyLabel('zh', 'on-request'), '按需询问');
  assert.equal(formatSandboxModeLabel('zh', 'workspace-write'), '工作区可写');
});

test('mode presentation renders and marks selected option', () => {
  const settings: ChatSessionSettings = {
    chatId: 'chat-mode',
    model: null,
    reasoningEffort: null,
    locale: 'en',
    accessPreset: null,
    collaborationMode: 'plan',
    confirmPlanBeforeExecute: true,
    autoQueueMessages: true,
    persistPlanHistory: true,
    updatedAt: Date.now(),
  };

  assert.equal(formatCollaborationModeLabel('en', 'plan'), 'Plan');
  assert.match(formatModeSettingsMessage('en', settings), /Current mode: <b>Plan<\/b>/);
  assert.deepEqual(buildModeSettingsKeyboard('en', settings), [[
    { text: 'Default', callback_data: 'settings:mode:default' },
    { text: '• Plan', callback_data: 'settings:mode:plan' },
  ], [
    { text: 'Settings', callback_data: 'settings:home' },
  ]]);
});

test('settings home presentation summarizes session state and exposes toggles', () => {
  const settings: ChatSessionSettings = {
    chatId: 'chat-settings',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    locale: 'en',
    accessPreset: 'default',
    collaborationMode: 'plan',
    confirmPlanBeforeExecute: true,
    autoQueueMessages: false,
    persistPlanHistory: true,
    updatedAt: Date.now(),
  };
  const access = {
    preset: 'default' as const,
    approvalPolicy: 'on-request' as const,
    sandboxMode: 'workspace-write' as const,
  };

  const rendered = formatSettingsHomeMessage('en', {
    threadId: 'thread-1',
    cwd: '/tmp/project',
    settings,
    access,
    queueDepth: 2,
    activeTurnId: 'turn-9',
  });
  const keyboard = buildSettingsHomeKeyboard('en', settings);

  assert.match(rendered, /<b>Settings<\/b>/);
  assert.match(rendered, /Thread: <b>thread-1<\/b>/);
  assert.match(rendered, /Queue depth: <b>2<\/b>/);
  assert.match(rendered, /Plan confirmation gate: yes/);
  assert.equal(keyboard[0]?.[0]?.text, 'Models');
  assert.equal(keyboard[1]?.[0]?.callback_data, 'settings:plan-gate:off');
  assert.equal(keyboard[2]?.[0]?.callback_data, 'settings:queue:on');
});

test('presentation renders chinese locale strings', () => {
  const threads: AppThread[] = [
    {
      threadId: 'thread-zh',
      name: '修复桥接',
      preview: '修复桥接',
      cwd: '/tmp/project',
      modelProvider: 'openai',
      status: 'active',
      updatedAt: Math.floor(Date.now() / 1000) - 30,
    },
  ];
  const renderedThreads = formatThreadsMessage('zh', threads, 'thread-zh');
  assert.match(renderedThreads, /<b>最近线程<\/b>/);
  assert.match(renderedThreads, /点击下方按钮可打开或重命名线程/);
  assert.match(renderedThreads, /当前：<b>修复桥接<\/b>/);

  const models: ModelInfo[] = [
    {
      id: 'model-o3',
      model: 'o3',
      displayName: 'OpenAI o3',
      description: 'Reasoning model',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
  ];
  const settings: ChatSessionSettings = {
    chatId: 'chat-zh',
    model: null,
    reasoningEffort: null,
    locale: 'zh',
    accessPreset: null,
    collaborationMode: null,
    confirmPlanBeforeExecute: true,
    autoQueueMessages: true,
    persistPlanHistory: true,
    updatedAt: Date.now(),
  };
  const renderedModels = formatModelSettingsMessage('zh', models, settings);
  assert.match(renderedModels, /<b>模型设置<\/b>/);
  assert.match(renderedModels, /模型：<b>服务端默认<\/b>/);
  assert.match(renderedModels, /推理强度：<b>服务端默认<\/b>/);
});
