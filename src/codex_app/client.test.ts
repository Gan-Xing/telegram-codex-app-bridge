import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Logger } from '../logger.js';
import { CodexAppClient, PLAN_MODE_DEVELOPER_INSTRUCTIONS } from './client.js';

function makeLogger(): Logger {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-client-test-'));
  return new Logger('error', path.join(logDir, 'bridge.log'));
}

test('revealThread fails clearly on unsupported hosts', async () => {
  const logger = makeLogger();
  const client = new CodexAppClient('codex', '', false, logger, 'freebsd');

  await assert.rejects(
    () => client.revealThread('thread-123'),
    /desktop deep links are not supported on this host \(freebsd\)/,
  );
});

test('startTurn sends plan collaboration instructions with recommended-option guidance', async () => {
  const client = new CodexAppClient('codex', '', false, makeLogger(), 'linux');
  let capturedMethod = '';
  let capturedParams: any = null;
  (client as any).request = async (method: string, params: any) => {
    capturedMethod = method;
    capturedParams = params;
    return { turn: { id: 'turn-1', status: 'running' } };
  };

  await client.startTurn({
    threadId: 'thread-1',
    input: [{ type: 'text', text: 'Plan this change', text_elements: [] }],
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    cwd: '/tmp/demo',
    model: 'gpt-5',
    effort: 'medium',
    collaborationMode: 'plan',
  });

  assert.equal(capturedMethod, 'turn/start');
  assert.equal(capturedParams?.collaborationMode?.mode, 'plan');
  assert.equal(
    capturedParams?.collaborationMode?.settings?.developer_instructions,
    PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  );
  assert.match(
    capturedParams?.collaborationMode?.settings?.developer_instructions,
    /Put the recommended option first\./,
  );
});
