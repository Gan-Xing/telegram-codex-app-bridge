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
    developerInstructions: null,
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

test('startTurn allows plan developer instructions to be overridden per turn', async () => {
  const client = new CodexAppClient('codex', '', false, makeLogger(), 'linux');
  let capturedParams: any = null;
  (client as any).request = async (_method: string, params: any) => {
    capturedParams = params;
    return { turn: { id: 'turn-2', status: 'running' } };
  };

  await client.startTurn({
    threadId: 'thread-2',
    input: [{ type: 'text', text: 'Confirm the plan', text_elements: [] }],
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    cwd: '/tmp/demo',
    model: 'gpt-5',
    effort: 'medium',
    collaborationMode: 'plan',
    developerInstructions: 'Execute only after the user confirms.',
  });

  assert.equal(
    capturedParams?.collaborationMode?.settings?.developer_instructions,
    'Execute only after the user confirms.',
  );
});

test('renameThread calls thread/name/set with threadId and name', async () => {
  const client = new CodexAppClient('codex', '', false, makeLogger(), 'linux');
  let capturedMethod = '';
  let capturedParams: any = null;
  (client as any).request = async (method: string, params: any) => {
    capturedMethod = method;
    capturedParams = params;
    return {};
  };

  await client.renameThread('019cd3f5-6f58-7580-ad62-44d93775169a', 'Renamed Thread');

  assert.equal(capturedMethod, 'thread/name/set');
  assert.deepEqual(capturedParams, {
    threadId: '019cd3f5-6f58-7580-ad62-44d93775169a',
    name: 'Renamed Thread',
  });
});

test('readAccountRateLimits maps the codex rate limit windows', async () => {
  const client = new CodexAppClient('codex', '', false, makeLogger(), 'linux');
  (client as any).request = async (method: string) => {
    assert.equal(method, 'account/rateLimits/read');
    return {
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1773082597 },
        secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1773531564 },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        planType: 'plus',
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: null,
          primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1773082597 },
          secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1773531564 },
          credits: { hasCredits: false, unlimited: false, balance: '0' },
          planType: 'plus',
        },
      },
    };
  };

  const limits = await client.readAccountRateLimits();

  assert.deepEqual(limits, {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1773082597 },
    secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1773531564 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'plus',
  });
  assert.deepEqual(client.getAccountRateLimits(), limits);
});

test('account/rateLimits/updated notification refreshes the cached limits', () => {
  const client = new CodexAppClient('codex', '', false, makeLogger(), 'linux');

  (client as any).handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1773082597 },
        secondary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: 1773531564 },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        planType: 'plus',
      },
    },
  }));

  assert.deepEqual(client.getAccountRateLimits(), {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1773082597 },
    secondary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: 1773531564 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'plus',
  });
});
