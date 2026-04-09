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

export function acquireProcessLock(lockPath: string): ProcessLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return acquireProcessLockInternal(lockPath, true);
}

function acquireProcessLockInternal(lockPath: string, allowStaleRetry: boolean): ProcessLock {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
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
          void 0;
        }
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          void 0;
        }
      },
    };
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    const pid = readLockPid(lockPath);
    if (allowStaleRetry && pid !== null && !isProcessAlive(pid)) {
      fs.rmSync(lockPath, { force: true });
      return acquireProcessLockInternal(lockPath, false);
    }
    throw new LockHeldError(lockPath, pid);
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const value = fs.readFileSync(lockPath, 'utf8').trim();
    if (!value) {
      return null;
    }
    const pid = Number.parseInt(value, 10);
    return Number.isFinite(pid) ? pid : null;
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
