import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('doctor reports platform, app-server, and desktop-open checks', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-doctor-test-'));
  const fakeCodex = path.join(tempDir, 'fake-codex');
  const defaultCwd = path.join(tempDir, 'workspace');
  fs.mkdirSync(defaultCwd, { recursive: true });
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "app-server" && "\${2:-}" == "--help" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "login" && "\${2:-}" == "status" ]]; then
  echo "logged in"
  exit 0
fi
exit 0
`, { mode: 0o755 });

  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', 'doctor'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_CLI_BIN: fakeCodex,
      TG_BOT_TOKEN: 'dummy-token',
      TG_ALLOWED_USER_ID: '1',
      DEFAULT_CWD: defaultCwd,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[OK\] codex app-server available/);
  assert.match(result.stdout, /\[OK\] platform detected:/);
  assert.match(result.stdout, /\[(OK|WARN)\] desktop open /);
});

test('doctor warns but does not fail when desktop open is unavailable', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-doctor-no-open-'));
  const fakeCodex = path.join(tempDir, 'fake-codex');
  const defaultCwd = path.join(tempDir, 'workspace');
  fs.mkdirSync(defaultCwd, { recursive: true });
  fs.writeFileSync(fakeCodex, `#!/bin/sh
if [ "\${1:-}" = "app-server" ] && [ "\${2:-}" = "--help" ]; then
  exit 0
fi
exit 0
`, { mode: 0o755 });

  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', 'doctor'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: tempDir,
      CODEX_CLI_BIN: fakeCodex,
      TG_BOT_TOKEN: 'dummy-token',
      TG_ALLOWED_USER_ID: '1',
      DEFAULT_CWD: defaultCwd,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[WARN\] desktop open unavailable:/);
});

test('doctor validates gemini cli availability when gemini is configured', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-doctor-gemini-'));
  const fakeGemini = path.join(tempDir, 'fake-gemini');
  const envFile = path.join(tempDir, '.env.gemini');
  const defaultCwd = path.join(tempDir, 'workspace');
  fs.mkdirSync(defaultCwd, { recursive: true });
  fs.writeFileSync(fakeGemini, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(envFile, [
    'BRIDGE_ENGINE=gemini',
    'TG_BOT_TOKEN=dummy-token',
    'TG_ALLOWED_USER_ID=1',
    `GEMINI_CLI_BIN=${fakeGemini}`,
    `DEFAULT_CWD=${defaultCwd}`,
  ].join('\n'), 'utf8');

  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', 'doctor'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ENV_FILE: envFile,
      BRIDGE_ENGINE: 'gemini',
      GEMINI_CLI_BIN: fakeGemini,
      TG_BOT_TOKEN: 'dummy-token',
      TG_ALLOWED_USER_ID: '1',
      DEFAULT_CWD: defaultCwd,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[OK\] gemini engine runtime available/);
  assert.match(result.stdout, /\[OK\] gemini cli available/);
});
