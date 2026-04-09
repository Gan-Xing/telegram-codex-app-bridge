import fs from 'node:fs';
import type { RuntimeStatus } from './types.js';

export function writeRuntimeStatus(path: string, status: RuntimeStatus): void {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf8');
  fs.renameSync(tmp, path);
}

export function readRuntimeStatus(path: string): RuntimeStatus | null {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8')) as RuntimeStatus;
  } catch {
    return null;
  }
}
