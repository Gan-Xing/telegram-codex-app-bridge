import fs from 'node:fs';
import path from 'node:path';

export function getWeixinSyncBufPath(syncBufDir: string, accountId: string): string {
  const safe = accountId.replace(/[^\w.-]+/g, '-');
  return path.join(syncBufDir, `${safe}.buf`);
}

export function loadGetUpdatesBuf(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw.length ? raw : null;
  } catch {
    return null;
  }
}

export function saveGetUpdatesBuf(filePath: string, buf: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf, 'utf-8');
}
