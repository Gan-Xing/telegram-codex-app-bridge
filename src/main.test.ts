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
  const fakeCodex = createFakeCli(tempDir, 'fake-codex', [
    'if [[ "${1:-}" == "app-server" && "${2:-}" == "--help" ]]; then',
    '  exit 0',
    'fi',
    'if [[ "${1:-}" == "login" && "${2:-}" == "status" ]]; then',
    '  echo "logged in"',
    '  exit 0',
    'fi',
    'exit 0',
  ]);
  const defaultCwd = path.join(tempDir, 'workspace');
  fs.mkdirSync(defaultCwd, { recursive: true });

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
  const fakeCodex = createFakeCli(tempDir, 'fake-codex', [
    'if [[ "${1:-}" == "app-server" && "${2:-}" == "--help" ]]; then',
    '  exit 0',
    'fi',
    'exit 0',
  ]);
  const blockedOpenCommand = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const lookupProgramName = process.platform === 'win32' ? 'where' : 'which';
  createFakeCommandLookup(tempDir, lookupProgramName, blockedOpenCommand);
  const defaultCwd = path.join(tempDir, 'workspace');
  fs.mkdirSync(defaultCwd, { recursive: true });

  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', 'doctor'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`,
      CODEX_CLI_BIN: fakeCodex,
      DEFAULT_CWD: defaultCwd,
      TG_ALLOWED_USER_ID: '1',
      TG_BOT_TOKEN: 'dummy-token',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  if (process.platform === 'win32') {
    assert.match(result.stdout, /\[OK\] desktop open available via cmd/);
  } else {
    assert.match(result.stdout, /\[WARN\] desktop open unavailable:/);
  }
});

test('doctor validates gemini cli availability when gemini is configured', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-doctor-gemini-'));
  const fakeGemini = createFakeCli(tempDir, 'fake-gemini', ['exit 0']);
  const envFile = path.join(tempDir, '.env.gemini');
  const defaultCwd = path.join(tempDir, 'workspace');
  fs.mkdirSync(defaultCwd, { recursive: true });
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

test('doctor validates claude cli availability when claude is configured', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-doctor-claude-'));
  const fakeClaude = createFakeCli(tempDir, 'fake-claude', ['exit 0']);
  const envFile = path.join(tempDir, '.env.claude');
  const defaultCwd = path.join(tempDir, 'workspace');
  fs.mkdirSync(defaultCwd, { recursive: true });
  fs.writeFileSync(envFile, [
    'BRIDGE_ENGINE=claude',
    'TG_BOT_TOKEN=dummy-token',
    'TG_ALLOWED_USER_ID=1',
    `CLAUDE_CLI_BIN=${fakeClaude}`,
    `DEFAULT_CWD=${defaultCwd}`,
  ].join('\n'), 'utf8');

  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', 'doctor'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ENV_FILE: envFile,
      BRIDGE_ENGINE: 'claude',
      CLAUDE_CLI_BIN: fakeClaude,
      TG_BOT_TOKEN: 'dummy-token',
      TG_ALLOWED_USER_ID: '1',
      DEFAULT_CWD: defaultCwd,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[OK\] claude engine runtime available/);
  assert.match(result.stdout, /\[OK\] claude cli available/);
});

function createFakeCli(tempDir: string, baseName: string, shellLines: string[]): string {
  if (process.platform === 'win32') {
    const scriptPath = path.join(tempDir, `${baseName}.cmd`);
    const hasAppServerCheck = shellLines.some((line) => line.includes('"app-server"') && line.includes('"--help"'));
    const hasLoginStatusCheck = shellLines.some((line) => line.includes('"login"') && line.includes('"status"'));
    const rendered = ['@echo off'];

    if (hasAppServerCheck) {
      rendered.push('if /I "%~1"=="app-server" if /I "%~2"=="--help" exit /b 0');
    }

    if (hasLoginStatusCheck) {
      rendered.push('if /I "%~1"=="login" if /I "%~2"=="status" (');
      rendered.push('  echo logged in');
      rendered.push('  exit /b 0');
      rendered.push(')');
    }

    rendered.push('exit /b 0');
    fs.writeFileSync(scriptPath, `${rendered.join('\r\n')}\r\n`, 'utf8');
    return scriptPath;
  }

  const scriptPath = path.join(tempDir, baseName);
  const rendered = ['#!/usr/bin/env bash', 'set -euo pipefail', ...shellLines].join('\n');
  fs.writeFileSync(scriptPath, `${rendered}\n`, { mode: 0o755 });
  return scriptPath;
}

function createFakeCommandLookup(tempDir: string, baseName: string, blockedCommand: string): string {
  if (process.platform === 'win32') {
    const scriptPath = path.join(tempDir, `${baseName}.cmd`);
    const rendered = [
      '@echo off',
      `if /I "%~1"=="${blockedCommand}" exit /b 1`,
      `where.exe %* >nul 2>nul`,
      'exit /b %errorlevel%',
    ];
    fs.writeFileSync(scriptPath, `${rendered.join('\r\n')}\r\n`, 'utf8');
    return scriptPath;
  }

  const scriptPath = path.join(tempDir, baseName);
  const rendered = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `if [[ "\${1:-}" == "${blockedCommand}" ]]; then`,
    '  exit 1',
    'fi',
    'command -v "${1:-}" >/dev/null 2>&1',
  ].join('\n');
  fs.writeFileSync(scriptPath, `${rendered}\n`, { mode: 0o755 });
  return scriptPath;
}
