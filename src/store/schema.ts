import type { SqliteDatabase } from './sqlite.js';
import { ensureColumn } from './shared.js';

export function initializeBridgeStoreSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_offsets (
      bot_key TEXT PRIMARY KEY,
      update_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_bindings (
      chat_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      cwd TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_settings (
      chat_id TEXT PRIMARY KEY,
      model TEXT,
      reasoning_effort TEXT,
      model_variant TEXT,
      service_tier TEXT,
      locale TEXT,
      access_preset TEXT,
      collaboration_mode TEXT,
      gemini_approval_mode TEXT,
      confirm_plan_before_execute INTEGER NOT NULL DEFAULT 1,
      auto_queue_messages INTEGER NOT NULL DEFAULT 1,
      persist_plan_history INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_cache (
      chat_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      name TEXT,
      preview TEXT NOT NULL,
      cwd TEXT,
      model_provider TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, idx)
    );
    CREATE TABLE IF NOT EXISTS thread_name_overrides (
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      custom_name TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS pending_approvals (
      local_id TEXT PRIMARY KEY,
      server_request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      approval_id TEXT,
      reason TEXT,
      command TEXT,
      cwd TEXT,
      summary TEXT,
      risk_level TEXT,
      details_json TEXT,
      message_id INTEGER,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS pending_user_inputs (
      local_id TEXT PRIMARY KEY,
      server_request_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      message_id INTEGER,
      questions_json TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      current_question_index INTEGER NOT NULL,
      awaiting_free_text INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS pending_user_input_messages (
      input_local_id TEXT NOT NULL,
      question_index INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      message_kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (input_local_id, question_index, message_kind)
    );
    CREATE TABLE IF NOT EXISTS pending_attachment_batches (
      batch_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      media_group_id TEXT,
      note_text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      receipt_message_id INTEGER,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS plan_sessions (
      session_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      source_turn_id TEXT,
      execution_turn_id TEXT,
      state TEXT NOT NULL,
      confirmation_required INTEGER NOT NULL DEFAULT 1,
      confirmed_plan_version INTEGER,
      latest_plan_version INTEGER,
      current_prompt_id TEXT,
      current_approval_id TEXT,
      queue_depth INTEGER NOT NULL DEFAULT 0,
      last_plan_message_id INTEGER,
      last_prompt_message_id INTEGER,
      last_approval_message_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS plan_snapshots (
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      source_event TEXT NOT NULL,
      explanation TEXT,
      steps_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, version)
    );
    CREATE TABLE IF NOT EXISTS queued_turn_inputs (
      queue_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      input_json TEXT NOT NULL,
      source_summary TEXT NOT NULL,
      telegram_message_id INTEGER,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS active_turn_previews (
      turn_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_history_previews (
      scope_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  ensureColumn(db, 'thread_cache', 'name', 'TEXT');
  ensureColumn(db, 'thread_cache', 'model_provider', 'TEXT');
  ensureColumn(db, 'thread_cache', 'status', "TEXT NOT NULL DEFAULT 'idle'");
  ensureColumn(db, 'chat_settings', 'locale', 'TEXT');
  ensureColumn(db, 'chat_settings', 'model_variant', 'TEXT');
  ensureColumn(db, 'chat_settings', 'service_tier', 'TEXT');
  ensureColumn(db, 'chat_settings', 'access_preset', 'TEXT');
  ensureColumn(db, 'chat_settings', 'collaboration_mode', 'TEXT');
  ensureColumn(db, 'chat_settings', 'gemini_approval_mode', 'TEXT');
  ensureColumn(db, 'chat_settings', 'confirm_plan_before_execute', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'chat_settings', 'auto_queue_messages', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'chat_settings', 'persist_plan_history', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'pending_approvals', 'summary', 'TEXT');
  ensureColumn(db, 'pending_approvals', 'risk_level', 'TEXT');
  ensureColumn(db, 'pending_approvals', 'details_json', 'TEXT');
  ensureColumn(db, 'pending_attachment_batches', 'media_group_id', 'TEXT');
  ensureColumn(db, 'pending_attachment_batches', 'note_text', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'pending_attachment_batches', 'attachments_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'pending_attachment_batches', 'receipt_message_id', 'INTEGER');
  ensureColumn(db, 'pending_attachment_batches', 'status', "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, 'pending_attachment_batches', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'pending_attachment_batches', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'pending_attachment_batches', 'resolved_at', 'INTEGER');
}
