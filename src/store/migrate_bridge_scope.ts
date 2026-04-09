import type { DatabaseSync } from 'node:sqlite';

import { BRIDGE_SCOPE_TELEGRAM_PREFIX, isBridgeScopedKey } from '../core/bridge_scope.js';

/**
 * One-time migration: prefix legacy Telegram-only keys so future channels (e.g. weixin) cannot collide.
 * Idempotent: rows already prefixed are skipped.
 */
export function migrateLegacyBridgeScopeIds(db: DatabaseSync): void {
  const needsMigrate = (key: string): boolean => !isBridgeScopedKey(key);

  db.exec('BEGIN IMMEDIATE');
  try {
    const bindingRows = db.prepare('SELECT chat_id FROM chat_bindings').all() as Array<{ chat_id: string }>;
    for (const row of bindingRows) {
      if (needsMigrate(row.chat_id)) {
        db.prepare('UPDATE chat_bindings SET chat_id = ? WHERE chat_id = ?').run(
          `${BRIDGE_SCOPE_TELEGRAM_PREFIX}${row.chat_id}`,
          row.chat_id,
        );
      }
    }

    const settingsRows = db.prepare('SELECT chat_id FROM chat_settings').all() as Array<{ chat_id: string }>;
    for (const row of settingsRows) {
      if (needsMigrate(row.chat_id)) {
        db.prepare('UPDATE chat_settings SET chat_id = ? WHERE chat_id = ?').run(
          `${BRIDGE_SCOPE_TELEGRAM_PREFIX}${row.chat_id}`,
          row.chat_id,
        );
      }
    }

    const cacheRows = db.prepare('SELECT DISTINCT chat_id FROM thread_cache').all() as Array<{ chat_id: string }>;
    for (const row of cacheRows) {
      if (needsMigrate(row.chat_id)) {
        const next = `${BRIDGE_SCOPE_TELEGRAM_PREFIX}${row.chat_id}`;
        db.prepare('UPDATE thread_cache SET chat_id = ? WHERE chat_id = ?').run(next, row.chat_id);
      }
    }

    const approvalRows = db.prepare('SELECT local_id, chat_id FROM pending_approvals').all() as Array<{
      local_id: string;
      chat_id: string;
    }>;
    for (const row of approvalRows) {
      if (needsMigrate(row.chat_id)) {
        db.prepare('UPDATE pending_approvals SET chat_id = ? WHERE local_id = ?').run(
          `${BRIDGE_SCOPE_TELEGRAM_PREFIX}${row.chat_id}`,
          row.local_id,
        );
      }
    }

    const auditRows = db.prepare('SELECT id, chat_id FROM audit_logs').all() as Array<{ id: number; chat_id: string }>;
    for (const row of auditRows) {
      if (needsMigrate(row.chat_id)) {
        db.prepare('UPDATE audit_logs SET chat_id = ? WHERE id = ?').run(
          `${BRIDGE_SCOPE_TELEGRAM_PREFIX}${row.chat_id}`,
          row.id,
        );
      }
    }

    const previewRows = db.prepare('SELECT turn_id, scope_id FROM active_turn_previews').all() as Array<{
      turn_id: string;
      scope_id: string;
    }>;
    for (const row of previewRows) {
      if (needsMigrate(row.scope_id)) {
        db.prepare('UPDATE active_turn_previews SET scope_id = ? WHERE turn_id = ?').run(
          `${BRIDGE_SCOPE_TELEGRAM_PREFIX}${row.scope_id}`,
          row.turn_id,
        );
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
