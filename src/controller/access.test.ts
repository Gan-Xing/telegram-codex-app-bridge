import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccessPreset, resolveAccessMode, resolveConfiguredAccessPreset } from './access.js';

test('resolveConfiguredAccessPreset falls back to default', () => {
  assert.equal(resolveConfiguredAccessPreset(null), 'default');
  assert.equal(resolveConfiguredAccessPreset({ accessPreset: null }), 'default');
  assert.equal(resolveConfiguredAccessPreset({ accessPreset: 'full-access' }), 'full-access');
});

test('normalizeAccessPreset only accepts supported presets', () => {
  assert.equal(normalizeAccessPreset('read-only'), 'read-only');
  assert.equal(normalizeAccessPreset('default'), 'default');
  assert.equal(normalizeAccessPreset('full-access'), 'full-access');
  assert.equal(normalizeAccessPreset('workspace-write'), null);
});

test('resolveAccessMode maps presets to effective approval and sandbox settings', () => {
  const config = {
    defaultApprovalPolicy: 'untrusted' as const,
    defaultSandboxMode: 'workspace-write' as const,
  };

  assert.deepEqual(resolveAccessMode(config, null), {
    preset: 'default',
    approvalPolicy: 'untrusted',
    sandboxMode: 'workspace-write',
  });
  assert.deepEqual(resolveAccessMode(config, { accessPreset: 'read-only' }), {
    preset: 'read-only',
    approvalPolicy: 'on-request',
    sandboxMode: 'read-only',
  });
  assert.deepEqual(resolveAccessMode(config, { accessPreset: 'full-access' }), {
    preset: 'full-access',
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
  });
});
