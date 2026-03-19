import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPlatformCapabilities, getCommandLookupProgram, getDesktopOpenSupport, getOpenUrlCommand } from './capabilities.js';

test('detectPlatformCapabilities returns launchd defaults on macOS', () => {
  assert.deepEqual(detectPlatformCapabilities('darwin'), {
    os: 'darwin',
    serviceManager: 'launchd',
    restartMode: 'service',
    supportsDesktopOpen: true,
    supportsDeepLink: true,
    supportsAutolaunch: true,
    commandLookupProgram: 'which',
  });
});

test('detectPlatformCapabilities returns systemd defaults on linux', () => {
  assert.deepEqual(detectPlatformCapabilities('linux'), {
    os: 'linux',
    serviceManager: 'systemd',
    restartMode: 'service',
    supportsDesktopOpen: true,
    supportsDeepLink: true,
    supportsAutolaunch: true,
    commandLookupProgram: 'which',
  });
});

test('detectPlatformCapabilities returns in-process restart defaults on Windows', () => {
  assert.deepEqual(detectPlatformCapabilities('win32'), {
    os: 'win32',
    serviceManager: 'manual',
    restartMode: 'in-process',
    supportsDesktopOpen: true,
    supportsDeepLink: true,
    supportsAutolaunch: true,
    commandLookupProgram: 'where',
  });
});

test('detectPlatformCapabilities returns manual defaults on unsupported platforms', () => {
  assert.deepEqual(detectPlatformCapabilities('freebsd'), {
    os: 'freebsd',
    serviceManager: 'manual',
    restartMode: 'none',
    supportsDesktopOpen: false,
    supportsDeepLink: false,
    supportsAutolaunch: false,
    commandLookupProgram: 'which',
  });
});

test('getCommandLookupProgram returns where on Windows', () => {
  assert.equal(getCommandLookupProgram('win32'), 'where');
});

test('getOpenUrlCommand returns xdg-open on linux', () => {
  assert.deepEqual(getOpenUrlCommand('codex://threads/abc', 'linux'), {
    command: 'xdg-open',
    args: ['codex://threads/abc'],
  });
});

test('getOpenUrlCommand rejects unsupported desktop open platforms', () => {
  assert.throws(
    () => getOpenUrlCommand('codex://threads/abc', 'freebsd'),
    /Desktop open is not supported on platform: freebsd/,
  );
});

test('getDesktopOpenSupport reports missing desktop opener commands', () => {
  assert.deepEqual(
    getDesktopOpenSupport('linux', () => false),
    {
      available: false,
      command: 'xdg-open',
      reason: 'xdg-open is not available in PATH',
    },
  );
});

test('getDesktopOpenSupport reports unsupported hosts clearly', () => {
  assert.deepEqual(
    getDesktopOpenSupport('freebsd'),
    {
      available: false,
      command: null,
      reason: 'desktop deep links are not supported on this host (freebsd)',
    },
  );
});
