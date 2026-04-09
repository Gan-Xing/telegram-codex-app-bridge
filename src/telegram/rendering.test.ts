import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTelegramRenderRoute } from './rendering.js';

test('private chat keeps draft capability but defaults to segmented streaming for stability', () => {
  const route = resolveTelegramRenderRoute('private', null);
  assert.deepEqual(route, {
    conversationKind: 'private_chat',
    preferredRenderer: 'segmented_stream',
    currentRenderer: 'segmented_stream',
    supportsDraftStreaming: true,
    usesMessageThread: false,
  });
});

test('private topic keeps thread metadata while using the stable segmented renderer', () => {
  const route = resolveTelegramRenderRoute('private', 9);
  assert.deepEqual(route, {
    conversationKind: 'private_topic',
    preferredRenderer: 'segmented_stream',
    currentRenderer: 'segmented_stream',
    supportsDraftStreaming: true,
    usesMessageThread: true,
  });
});

test('group topic stays on segmented renderer', () => {
  const route = resolveTelegramRenderRoute('supergroup', 8);
  assert.deepEqual(route, {
    conversationKind: 'group_topic',
    preferredRenderer: 'segmented_stream',
    currentRenderer: 'segmented_stream',
    supportsDraftStreaming: false,
    usesMessageThread: true,
  });
});
