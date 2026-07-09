import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export interface ProcessLock {
  release(): void;
}

export class LockHeldError extends Error {
  constructor(lockPath: string, pid: number | null) {
    super(pid === null
      ? `Lock already held: ${lockPath}`
      : `Lock already held by pid ${pid}: ${lockPath}`);
  }
}

interface LockInfo {
  pid: number | null;
  bootId: string | null;
  mtimeMs: number | null;
}

export function acquireProcessLock(lockPath: string): ProcessLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return acquireProcessLockInternal(lockPath, true);
}

function acquireProcessLockInternal(lockPath: string, allowStaleRetry: boolean): ProcessLock {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    const bootId = readCurrentBootId();
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, bootId })}\n`, 'utf8');
    let released = false;
    return {
      release(): void {
        if (released) {
          return;
        }
        released = true;
        try {
          fs.closeSync(fd);
        } catch {
          // Best effort: the descriptor may already be closed during shutdown.
        }
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Best effort: lock cleanup should not fail release.
        }
      },
    };
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    const lockInfo = readLockInfo(lockPath);
    const pid = lockInfo.pid;
    if (allowStaleRetry && isStaleLock(lockInfo)) {
      fs.rmSync(lockPath, { force: true });
      return acquireProcessLockInternal(lockPath, false);
    }
    throw new LockHeldError(lockPath, pid);
  }
}

function readLockInfo(lockPath: string): LockInfo {
  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    // If stat fails, keep the read error path below responsible for the pid.
  }
  try {
    const value = fs.readFileSync(lockPath, 'utf8').trim();
    if (!value) {
      return { pid: null, bootId: null, mtimeMs };
    }
    if (value.startsWith('{')) {
      const parsed = JSON.parse(value) as { pid?: unknown; bootId?: unknown };
      const pid = typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : null;
      const bootId = typeof parsed.bootId === 'string' && parsed.bootId ? parsed.bootId : null;
      return { pid, bootId, mtimeMs };
    }
    const pid = Number.parseInt(value, 10);
    return { pid: Number.isFinite(pid) ? pid : null, bootId: null, mtimeMs };
  } catch {
    return { pid: null, bootId: null, mtimeMs };
  }
}

function isStaleLock(lockInfo: LockInfo): boolean {
  const currentBootId = readCurrentBootId();
  if (lockInfo.bootId !== null && currentBootId !== null && lockInfo.bootId !== currentBootId) {
    return true;
  }
  const bootTimeMs = readSystemBootTimeMs();
  if (lockInfo.bootId === null && lockInfo.mtimeMs !== null && bootTimeMs !== null && lockInfo.mtimeMs < bootTimeMs) {
    return true;
  }
  return lockInfo.pid !== null && !isProcessAlive(lockInfo.pid);
}

function readCurrentBootId(): string | null {
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return bootId || null;
  } catch {
    return null;
  }
}

function readSystemBootTimeMs(): number | null {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const match = /^btime\s+(\d+)$/m.exec(stat);
    return match?.[1] ? Number.parseInt(match[1], 10) * 1000 : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as any).code === 'EEXIST';
}
