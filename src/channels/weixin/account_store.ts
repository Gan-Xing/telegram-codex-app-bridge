import fs from 'node:fs';
import path from 'node:path';

/** Persisted after QR login; `accountId` is ilink_bot_id from iLink. */
export interface WeixinSavedAccount {
  accountId: string;
  botToken: string;
  baseUrl: string;
  /** User who scanned QR (reference only). */
  linkedIlinkUserId?: string;
  savedAt: number;
}

export function defaultWeixinAccountsDir(appHome: string): string {
  return path.join(appHome, 'weixin', 'accounts');
}

export function accountFilePath(accountsDir: string, accountId: string): string {
  const safe = accountId.replace(/[^\w.-]+/g, '-');
  return path.join(accountsDir, `${safe}.json`);
}

export function saveWeixinAccount(accountsDir: string, record: WeixinSavedAccount): void {
  fs.mkdirSync(accountsDir, { recursive: true });
  const filePath = accountFilePath(accountsDir, record.accountId);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

export function loadWeixinAccount(accountsDir: string, accountId: string): WeixinSavedAccount | null {
  const filePath = accountFilePath(accountsDir, accountId);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as WeixinSavedAccount;
    if (!parsed.accountId || !parsed.botToken || !parsed.baseUrl) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function listWeixinAccountIds(accountsDir: string): string[] {
  if (!fs.existsSync(accountsDir)) {
    return [];
  }
  const ids: string[] = [];
  for (const name of fs.readdirSync(accountsDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(accountsDir, name), 'utf-8');
      const parsed = JSON.parse(raw) as WeixinSavedAccount;
      if (parsed.accountId) {
        ids.push(parsed.accountId);
      }
    } catch {
      // skip invalid
    }
  }
  return ids;
}

export function listWeixinAccounts(accountsDir: string): WeixinSavedAccount[] {
  return listWeixinAccountIds(accountsDir)
    .map((id) => loadWeixinAccount(accountsDir, id))
    .filter((a): a is WeixinSavedAccount => a !== null);
}
