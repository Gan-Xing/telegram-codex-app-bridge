import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireProcessLock, LockHeldError } from './lock.js';

test('process lock prevents a second live holder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lock-'));
  const lockPath = path.join(dir, 'bridge.lock');
  const lock = acquireProcessLock(lockPath);
  assert.throws(() => acquireProcessLock(lockPath), LockHeldError);
  lock.release();
});

test('process lock replaces stale pid files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lock-'));
  const lockPath = path.join(dir, 'bridge.lock');
  fs.writeFileSync(lockPath, '999999\n', 'utf8');
  const lock = acquireProcessLock(lockPath);
  assert.equal(fs.existsSync(lockPath), true);
  lock.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('process lock replaces old-boot pid files even when pid was reused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lock-'));
  const lockPath = path.join(dir, 'bridge.lock');
  fs.writeFileSync(lockPath, `${process.pid}\n`, 'utf8');
  fs.utimesSync(lockPath, new Date(0), new Date(0));
  const lock = acquireProcessLock(lockPath);
  assert.equal(fs.existsSync(lockPath), true);
  lock.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('process lock replaces different-boot structured lock files even when pid is alive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lock-'));
  const lockPath = path.join(dir, 'bridge.lock');
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, bootId: 'previous-boot' })}\n`, 'utf8');
  const lock = acquireProcessLock(lockPath);
  assert.equal(fs.existsSync(lockPath), true);
  lock.release();
  assert.equal(fs.existsSync(lockPath), false);
});
