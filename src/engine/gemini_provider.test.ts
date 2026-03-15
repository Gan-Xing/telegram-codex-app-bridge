import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Logger } from '../logger.js';
import { createGeminiEngineProvider } from './gemini_provider.js';

function createProvider(config: {
  geminiDefaultModel: string | null;
  geminiModelAllowlist: string[];
}) {
  return createGeminiEngineProvider({
    geminiCliBin: 'gemini',
    geminiDefaultModel: config.geminiDefaultModel,
    geminiModelAllowlist: config.geminiModelAllowlist,
    geminiIncludeDirectories: [],
    geminiHeadlessTimeoutMs: 300_000,
    defaultCwd: os.tmpdir(),
  }, new Logger('error', path.join(os.tmpdir(), 'telegram-gemini-provider.test.log')));
}

test('listModels falls back to the built-in Gemini catalog when allowlist is empty', async () => {
  const provider = createProvider({
    geminiDefaultModel: null,
    geminiModelAllowlist: [],
  });

  const models = await provider.listModels();
  assert.deepEqual(models.map((entry) => entry.model), [
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ]);
  assert.equal(models[0]?.isDefault, true);
});

test('listModels prioritizes the configured default model ahead of the allowlist', async () => {
  const provider = createProvider({
    geminiDefaultModel: 'gemini-3-flash-preview',
    geminiModelAllowlist: [
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
    ],
  });

  const models = await provider.listModels();
  assert.deepEqual(models.map((entry) => entry.model), [
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-2.5-pro',
  ]);
  assert.equal(models[0]?.isDefault, true);
});
