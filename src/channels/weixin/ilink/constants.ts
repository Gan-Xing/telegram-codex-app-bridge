import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** iLink app id (matches openclaw-weixin package.json ilink_appid). */
export const ILINK_APP_ID = 'bot';

export const FIXED_QR_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

function readBridgeVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, '../../../..', 'package.json');
    const j = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return j.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const BRIDGE_PACKAGE_VERSION = readBridgeVersion();

export function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

export const ILINK_APP_CLIENT_VERSION = buildClientVersion(BRIDGE_PACKAGE_VERSION);
