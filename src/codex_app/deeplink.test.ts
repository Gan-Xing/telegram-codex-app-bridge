import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThreadDeepLink, getOpenUrlCommand } from './deeplink.js';

test('buildThreadDeepLink targets the Codex thread route', () => {
  assert.equal(
    buildThreadDeepLink('019cc36a-fd75-7241-be1c-06b46b938970'),
    'codex://threads/019cc36a-fd75-7241-be1c-06b46b938970',
  );
});

test('buildThreadDeepLink encodes unsafe thread ids', () => {
  assert.equal(
    buildThreadDeepLink('thread with spaces/and/slashes'),
    'codex://threads/thread%20with%20spaces%2Fand%2Fslashes',
  );
});

test('getOpenUrlCommand returns macOS open invocation', () => {
  assert.deepEqual(
    getOpenUrlCommand('codex://threads/abc', 'darwin'),
    { command: 'open', args: ['codex://threads/abc'] },
  );
});

test('getOpenUrlCommand returns Windows start invocation', () => {
  assert.deepEqual(
    getOpenUrlCommand('codex://threads/abc', 'win32'),
    { command: 'cmd', args: ['/c', 'start', '', 'codex://threads/abc'] },
  );
});

test('getOpenUrlCommand returns xdg-open invocation on linux', () => {
  assert.deepEqual(
    getOpenUrlCommand('codex://threads/abc', 'linux'),
    { command: 'xdg-open', args: ['codex://threads/abc'] },
  );
});
