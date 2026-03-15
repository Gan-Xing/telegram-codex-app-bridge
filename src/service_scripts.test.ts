import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openSqliteDatabase } from './store/sqlite.js';

function writeExecutable(pathname: string, content: string): void {
  fs.writeFileSync(pathname, content, { mode: 0o755 });
}

test('linux service scripts manage the systemd user lifecycle through the unified entrypoints', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-service-test-'));
  const fakeHome = path.join(tempDir, 'home');
  const fakeBin = path.join(tempDir, 'bin');
  const fakeConfigHome = path.join(tempDir, '.config');
  const envFile = path.join(tempDir, '.env');
  const systemctlLog = path.join(tempDir, 'systemctl.log');
  const journalctlLog = path.join(tempDir, 'journalctl.log');
  const realUname = spawnSync('sh', ['-c', 'command -v uname'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/uname';
  const distDir = path.join(rootDir, 'dist');
  const distMainPath = path.join(distDir, 'main.js');
  const distMainExisted = fs.existsSync(distMainPath);

  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(fakeConfigHome, { recursive: true });
  fs.writeFileSync(envFile, '', 'utf8');
  if (!distMainExisted) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(distMainPath, 'console.log("test stub");\n', 'utf8');
  }

  writeExecutable(path.join(fakeBin, 'systemctl'), `#!/bin/sh
printf '%s\n' "$*" >> "${systemctlLog}"
if [ "\${2:-}" = "status" ]; then
  echo "fake systemd status"
fi
exit 0
`);

  writeExecutable(path.join(fakeBin, 'journalctl'), `#!/bin/sh
printf '%s\n' "$*" >> "${journalctlLog}"
echo "fake journal log"
exit 0
`);

  writeExecutable(path.join(fakeBin, 'uname'), `#!/bin/sh
if [ "\${1:-}" = "-s" ]; then
  echo "Linux"
  exit 0
fi
exec "${realUname}" "$@"
`);

  const env = {
    ...process.env,
    HOME: fakeHome,
    XDG_CONFIG_HOME: fakeConfigHome,
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
    FOLLOW: 'false',
    LINES: '5',
    ENV_FILE: envFile,
  };

  const runScript = (relativePath: string) => spawnSync('bash', [path.join(rootDir, relativePath)], {
    cwd: rootDir,
    env,
    encoding: 'utf8',
  });

  try {
    const install = runScript('scripts/service/install.sh');
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const unitPath = path.join(fakeConfigHome, 'systemd', 'user', 'com.ganxing.telegram-codex-app-bridge.service');
    const runnerPath = path.join(fakeHome, '.telegram-codex-app-bridge', 'bin', 'run-bridge.sh');
    assert.equal(fs.existsSync(unitPath), true);
    assert.equal(fs.existsSync(runnerPath), true);
    const unitContent = fs.readFileSync(unitPath, 'utf8');
    assert.match(unitContent, /ExecStart=.*run-bridge\.sh/);
    assert.match(unitContent, /WorkingDirectory=/);

    const status = runScript('scripts/service/status.sh');
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /fake systemd status/);

    const logs = runScript('scripts/service/logs.sh');
    assert.equal(logs.status, 0, logs.stderr || logs.stdout);
    assert.match(logs.stdout, /fake journal log/);

    const restart = runScript('scripts/service/restart.sh');
    assert.equal(restart.status, 0, restart.stderr || restart.stdout);

    const stop = runScript('scripts/service/stop.sh');
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);

    const uninstall = runScript('scripts/service/uninstall.sh');
    assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.equal(fs.existsSync(unitPath), false);

    const systemctlCalls = fs.readFileSync(systemctlLog, 'utf8');
    assert.match(systemctlCalls, /--user daemon-reload/);
    assert.match(systemctlCalls, /--user enable --now com\.ganxing\.telegram-codex-app-bridge\.service/);
    assert.match(systemctlCalls, /--user status com\.ganxing\.telegram-codex-app-bridge\.service --no-pager/);
    assert.match(systemctlCalls, /--user restart com\.ganxing\.telegram-codex-app-bridge\.service/);
    assert.match(systemctlCalls, /--user stop com\.ganxing\.telegram-codex-app-bridge\.service/);
    assert.match(systemctlCalls, /--user disable --now com\.ganxing\.telegram-codex-app-bridge\.service/);

    const journalctlCalls = fs.readFileSync(journalctlLog, 'utf8');
    assert.match(journalctlCalls, /--user -u com\.ganxing\.telegram-codex-app-bridge\.service -n 5 --no-pager/);
  } finally {
    if (!distMainExisted && fs.existsSync(distMainPath)) {
      fs.rmSync(distMainPath, { force: true });
    }
  }
});

test('linux service scripts isolate runner paths and unit names per instance env', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-service-instance-test-'));
  const fakeHome = path.join(tempDir, 'home');
  const fakeBin = path.join(tempDir, 'bin');
  const fakeConfigHome = path.join(tempDir, '.config');
  const envFile = path.join(tempDir, '.env.gemini');
  const bridgeHome = path.join(fakeHome, 'bridges', 'linux144-gemini');
  const systemctlLog = path.join(tempDir, 'systemctl.log');
  const realUname = spawnSync('sh', ['-c', 'command -v uname'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/uname';
  const distDir = path.join(rootDir, 'dist');
  const distMainPath = path.join(distDir, 'main.js');
  const distMainExisted = fs.existsSync(distMainPath);

  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(fakeConfigHome, { recursive: true });
  fs.writeFileSync(envFile, [
    'BRIDGE_ENGINE=gemini',
    'BRIDGE_INSTANCE_ID=linux144-gemini',
    `BRIDGE_HOME=${bridgeHome}`,
  ].join('\n'), 'utf8');
  if (!distMainExisted) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(distMainPath, 'console.log("test stub");\n', 'utf8');
  }

  writeExecutable(path.join(fakeBin, 'systemctl'), `#!/bin/sh
printf '%s\n' "$*" >> "${systemctlLog}"
exit 0
`);

  writeExecutable(path.join(fakeBin, 'uname'), `#!/bin/sh
if [ "\${1:-}" = "-s" ]; then
  echo "Linux"
  exit 0
fi
exec "${realUname}" "$@"
`);

  const env = {
    ...process.env,
    HOME: fakeHome,
    XDG_CONFIG_HOME: fakeConfigHome,
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
    ENV_FILE: envFile,
  };

  const runScript = (relativePath: string) => spawnSync('bash', [path.join(rootDir, relativePath)], {
    cwd: rootDir,
    env,
    encoding: 'utf8',
  });

  try {
    const install = runScript('scripts/service/install.sh');
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const unitPath = path.join(fakeConfigHome, 'systemd', 'user', 'com.ganxing.telegram-codex-app-bridge-linux144-gemini.service');
    const runnerPath = path.join(bridgeHome, 'bin', 'run-bridge.sh');
    assert.equal(fs.existsSync(unitPath), true);
    assert.equal(fs.existsSync(runnerPath), true);

    const unitContent = fs.readFileSync(unitPath, 'utf8');
    assert.match(unitContent, /Description=Telegram Gemini App Bridge \(linux144-gemini\)/);

    const runnerContent = fs.readFileSync(runnerPath, 'utf8');
    assert.match(runnerContent, /export ENV_FILE=/);
    assert.match(runnerContent, /export BRIDGE_ENGINE=gemini/);
    assert.match(runnerContent, /export BRIDGE_INSTANCE_ID=linux144-gemini/);
    assert.match(runnerContent, new RegExp(`export BRIDGE_HOME=${bridgeHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    const restart = runScript('scripts/service/restart.sh');
    assert.equal(restart.status, 0, restart.stderr || restart.stdout);

    const uninstall = runScript('scripts/service/uninstall.sh');
    assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

    const systemctlCalls = fs.readFileSync(systemctlLog, 'utf8');
    assert.match(systemctlCalls, /--user enable --now com\.ganxing\.telegram-codex-app-bridge-linux144-gemini\.service/);
    assert.match(systemctlCalls, /--user restart com\.ganxing\.telegram-codex-app-bridge-linux144-gemini\.service/);
    assert.match(systemctlCalls, /--user disable --now com\.ganxing\.telegram-codex-app-bridge-linux144-gemini\.service/);
  } finally {
    if (!distMainExisted && fs.existsSync(distMainPath)) {
      fs.rmSync(distMainPath, { force: true });
    }
  }
});

test('restart-safe parses spaced env values and notifies the latest inbound private scope', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-restart-safe-test-'));
  const fakeHome = path.join(tempDir, 'home');
  const fakeBin = path.join(tempDir, 'bin');
  const fakeConfigHome = path.join(tempDir, '.config');
  const fakeDataDir = path.join(fakeHome, '.telegram-codex-app-bridge', 'data');
  const statusFile = path.join(fakeHome, '.telegram-codex-app-bridge', 'runtime', 'status.json');
  const dbPath = path.join(fakeDataDir, 'bridge.sqlite');
  const envFile = path.join(tempDir, '.env');
  const curlLog = path.join(tempDir, 'curl.log');
  const systemctlLog = path.join(tempDir, 'systemctl.log');
  const realUname = spawnSync('sh', ['-c', 'command -v uname'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/uname';

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(fakeConfigHome, { recursive: true });
  fs.mkdirSync(fakeDataDir, { recursive: true });
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.mkdirSync(path.join(fakeConfigHome, 'systemd', 'user'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeConfigHome, 'systemd', 'user', 'com.ganxing.telegram-codex-app-bridge.service'),
    '[Unit]\nDescription=test\n',
    'utf8',
  );
  fs.writeFileSync(statusFile, JSON.stringify({
    running: true,
    connected: true,
    updatedAt: '2000-01-01T00:00:00.000Z',
  }), 'utf8');
  fs.writeFileSync(envFile, [
    'TG_BOT_TOKEN=test-token',
    'TG_ALLOWED_USER_ID=7689890344',
    'TG_ALLOWED_CHAT_ID=-1003742428605',
    'TG_ALLOWED_TOPIC_ID=2',
    'CODEX_APP_LAUNCH_CMD=codex app',
    `STORE_PATH=${dbPath}`,
  ].join('\n'), 'utf8');

  const db = openSqliteDatabase(dbPath);
  db.exec(`
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE chat_settings (
      chat_id TEXT PRIMARY KEY,
      locale TEXT
    );
  `);
  db.prepare('INSERT INTO audit_logs (direction, chat_id, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('inbound', '-1003742428605::2', 'telegram.message', 'group', 10);
  db.prepare('INSERT INTO audit_logs (direction, chat_id, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('inbound', '7689890344::root', 'telegram.message', 'private', 20);
  db.prepare('INSERT INTO chat_settings (chat_id, locale) VALUES (?, ?)')
    .run('7689890344::root', 'zh');
  db.close();

  writeExecutable(path.join(fakeBin, 'systemctl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${systemctlLog}"`,
    'if [ "${2:-}" = "restart" ]; then',
    `  node -e "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ running: true, connected: true, updatedAt: new Date().toISOString() }))" "${statusFile}"`,
    'fi',
    'exit 0',
    '',
  ].join('\n'));

  writeExecutable(path.join(fakeBin, 'curl'), `#!/bin/sh
printf '%s\n' "$*" >> "${curlLog}"
printf '{"ok":true}'
exit 0
`);

  writeExecutable(path.join(fakeBin, 'uname'), [
    '#!/bin/sh',
    'if [ "${1:-}" = "-s" ]; then',
    '  echo "Linux"',
    '  exit 0',
    'fi',
    `exec "${realUname}" "$@"`,
    '',
  ].join('\n'));

  const result = spawnSync('bash', [path.join(rootDir, 'scripts/service/restart-safe.sh')], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOME: fakeHome,
      XDG_CONFIG_HOME: fakeConfigHome,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
      ENV_FILE: envFile,
      STATUS_FILE: statusFile,
      BUILD_BEFORE_RESTART: 'false',
      RESTART_TIMEOUT_SEC: '5',
      RESTART_POLL_SEC: '1',
      DETACH: 'false',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[bridge\] 重启已开始/);
  assert.match(result.stdout, /\[bridge\] 重启成功/);
  assert.match(result.stdout, /状态: 运行中=true 已连接=true/);

  const curlCalls = fs.readFileSync(curlLog, 'utf8');
  assert.match(curlCalls, /chat_id=7689890344/);
  assert.doesNotMatch(curlCalls, /message_thread_id=/);

  const systemctlCalls = fs.readFileSync(systemctlLog, 'utf8');
  assert.match(systemctlCalls, /--user daemon-reload/);
  assert.match(systemctlCalls, /--user restart com\.ganxing\.telegram-codex-app-bridge\.service/);
});

test('restart-safe auto-detaches inside the bridge service and still emits the final callback', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-restart-safe-auto-detach-'));
  const fakeHome = path.join(tempDir, 'home');
  const fakeBin = path.join(tempDir, 'bin');
  const fakeConfigHome = path.join(tempDir, '.config');
  const fakeDataDir = path.join(fakeHome, '.telegram-codex-app-bridge', 'data');
  const statusFile = path.join(fakeHome, '.telegram-codex-app-bridge', 'runtime', 'status.json');
  const dbPath = path.join(fakeDataDir, 'bridge.sqlite');
  const envFile = path.join(tempDir, '.env');
  const curlLog = path.join(tempDir, 'curl.log');
  const systemctlLog = path.join(tempDir, 'systemctl.log');
  const systemdRunLog = path.join(tempDir, 'systemd-run.log');
  const systemdRunEnvLog = path.join(tempDir, 'systemd-run.env.log');
  const fakeCgroupFile = path.join(tempDir, 'cgroup');
  const realUname = spawnSync('sh', ['-c', 'command -v uname'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/uname';

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(fakeConfigHome, { recursive: true });
  fs.mkdirSync(fakeDataDir, { recursive: true });
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.mkdirSync(path.join(fakeConfigHome, 'systemd', 'user'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeConfigHome, 'systemd', 'user', 'com.ganxing.telegram-codex-app-bridge.service'),
    '[Unit]\nDescription=test\n',
    'utf8',
  );
  fs.writeFileSync(statusFile, JSON.stringify({
    running: true,
    connected: true,
    updatedAt: '2000-01-01T00:00:00.000Z',
  }), 'utf8');
  fs.writeFileSync(envFile, [
    'TG_BOT_TOKEN=test-token',
    'TG_ALLOWED_USER_ID=7689890344',
    'TG_ALLOWED_CHAT_ID=-1003742428605',
    'TG_ALLOWED_TOPIC_ID=2',
    `STORE_PATH=${dbPath}`,
  ].join('\n'), 'utf8');
  fs.writeFileSync(
    fakeCgroupFile,
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/com.ganxing.telegram-codex-app-bridge.service\n',
    'utf8',
  );

  const db = openSqliteDatabase(dbPath);
  db.exec(`
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO audit_logs (direction, chat_id, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('inbound', '7689890344::root', 'telegram.message', 'private', 20);
  db.close();

  writeExecutable(path.join(fakeBin, 'systemctl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${systemctlLog}"`,
    'if [ "${2:-}" = "restart" ]; then',
    `  node -e "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ running: true, connected: true, updatedAt: new Date().toISOString() }))" "${statusFile}"`,
    'fi',
    'exit 0',
    '',
  ].join('\n'));

  writeExecutable(path.join(fakeBin, 'systemd-run'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${systemdRunLog}"`,
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --setenv=*)',
    '      kv="${1#--setenv=}"',
    `      printf '%s\\n' "$kv" >> "${systemdRunEnvLog}"`,
    '      export "$kv"',
    '      shift',
    '      ;;',
    '    --unit)',
    '      shift 2',
    '      ;;',
    '    --user|--collect|--quiet)',
    '      shift',
    '      ;;',
    '    *)',
    '      break',
    '      ;;',
    '  esac',
    'done',
    '"$@"',
    '',
  ].join('\n'));

  writeExecutable(path.join(fakeBin, 'curl'), `#!/bin/sh
printf '%s\n' "$*" >> "${curlLog}"
printf '{"ok":true}'
exit 0
`);

  writeExecutable(path.join(fakeBin, 'uname'), [
    '#!/bin/sh',
    'if [ "${1:-}" = "-s" ]; then',
    '  echo "Linux"',
    '  exit 0',
    'fi',
    `exec "${realUname}" "$@"`,
    '',
  ].join('\n'));

  const result = spawnSync('bash', [path.join(rootDir, 'scripts/service/restart-safe.sh')], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOME: fakeHome,
      XDG_CONFIG_HOME: fakeConfigHome,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
      ENV_FILE: envFile,
      STATUS_FILE: statusFile,
      BUILD_BEFORE_RESTART: 'false',
      RESTART_TIMEOUT_SEC: '5',
      RESTART_POLL_SEC: '1',
      SAFE_RESTART_CGROUP_FILE: fakeCgroupFile,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[bridge\] restart started/);
  assert.match(result.stdout, /Detached unit launched:/);
  assert.match(result.stdout, /\[bridge\] restart succeeded/);
  assert.doesNotMatch(result.stdout, /\[bridge\] restart queued \(detached\)/);

  const curlCalls = fs.readFileSync(curlLog, 'utf8');
  assert.equal((curlCalls.match(/chat_id=7689890344/g) ?? []).length, 2);
  assert.doesNotMatch(curlCalls, /message_thread_id=/);

  const systemdRunEnv = fs.readFileSync(systemdRunEnvLog, 'utf8');
  assert.match(systemdRunEnv, /^DETACH=false$/m);
  assert.match(systemdRunEnv, /^START_NOTIFY=false$/m);
  assert.match(systemdRunEnv, /^NOTIFY_SCOPE_ID=7689890344::root$/m);

  const systemdRunCalls = fs.readFileSync(systemdRunLog, 'utf8');
  assert.doesNotMatch(systemdRunCalls, /(^|\s)-lc(\s|$)/);

  const systemctlCalls = fs.readFileSync(systemctlLog, 'utf8');
  assert.match(systemctlCalls, /--user restart com\.ganxing\.telegram-codex-app-bridge\.service/);
});
