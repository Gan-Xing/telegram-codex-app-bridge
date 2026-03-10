import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_GUIDED_PLAN_PREFERENCES } from '../types.js';
import type {
  AccessPresetValue,
  AppLocale,
  CachedThread,
  ChatSessionSettings,
  CollaborationModeValue,
  GuidedPlanSession,
  GuidedPlanSessionState,
  PendingUserInputMessageKind,
  PendingUserInputMessageRecord,
  PendingApprovalRecord,
  PendingUserInputQuestion,
  PendingUserInputRecord,
  PlanSnapshotRecord,
  PlanSnapshotStep,
  QueuedTurnInputRecord,
  QueuedTurnInputStatus,
  ReasoningEffortValue,
  ThreadBinding,
} from '../types.js';

export interface ActiveTurnPreviewRecord {
  turnId: string;
  scopeId: string;
  threadId: string;
  messageId: number;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadHistoryPreviewRecord {
  scopeId: string;
  threadId: string;
  messageId: number;
  createdAt: number;
  updatedAt: number;
}

export interface HistoricalCleanupOptions {
  maxResolvedAgeMs: number;
  maxResolvedPlanSessionsPerChat: number;
}

export interface HistoricalCleanupResult {
  deletedPlanSessions: number;
  deletedPlanSnapshots: number;
  deletedPendingApprovals: number;
  deletedPendingUserInputs: number;
  deletedPendingUserInputMessages: number;
  deletedQueuedTurnInputs: number;
}

export class BridgeStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
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
        locale TEXT,
        access_preset TEXT,
        collaboration_mode TEXT,
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
    this.ensureColumn('thread_cache', 'name', 'TEXT');
    this.ensureColumn('thread_cache', 'model_provider', 'TEXT');
    this.ensureColumn('thread_cache', 'status', "TEXT NOT NULL DEFAULT 'idle'");
    this.ensureColumn('chat_settings', 'locale', 'TEXT');
    this.ensureColumn('chat_settings', 'access_preset', 'TEXT');
    this.ensureColumn('chat_settings', 'collaboration_mode', 'TEXT');
    this.ensureColumn('chat_settings', 'confirm_plan_before_execute', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('chat_settings', 'auto_queue_messages', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('chat_settings', 'persist_plan_history', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('pending_approvals', 'summary', 'TEXT');
    this.ensureColumn('pending_approvals', 'risk_level', 'TEXT');
    this.ensureColumn('pending_approvals', 'details_json', 'TEXT');
  }

  getTelegramOffset(botKey: string): number {
    const row = this.db.prepare('SELECT update_id FROM telegram_offsets WHERE bot_key = ?').get(botKey) as { update_id: number } | undefined;
    return row?.update_id ?? 0;
  }

  setTelegramOffset(botKey: string, updateId: number): void {
    this.db.prepare(`
      INSERT INTO telegram_offsets (bot_key, update_id)
      VALUES (?, ?)
      ON CONFLICT(bot_key) DO UPDATE SET update_id = excluded.update_id
    `).run(botKey, updateId);
  }

  getBinding(chatId: string): ThreadBinding | null {
    const row = this.db.prepare('SELECT chat_id, thread_id, cwd, updated_at FROM chat_bindings WHERE chat_id = ?').get(chatId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      cwd: row.cwd === null ? null : String(row.cwd),
      updatedAt: Number(row.updated_at)
    };
  }

  setBinding(chatId: string, threadId: string, cwd: string | null): void {
    this.db.prepare(`
      INSERT INTO chat_bindings (chat_id, thread_id, cwd, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET thread_id = excluded.thread_id, cwd = excluded.cwd, updated_at = excluded.updated_at
    `).run(chatId, threadId, cwd, Date.now());
  }

  getChatSettings(chatId: string): ChatSessionSettings | null {
    const row = this.db.prepare(`
      SELECT
        chat_id,
        model,
        reasoning_effort,
        locale,
        access_preset,
        collaboration_mode,
        confirm_plan_before_execute,
        auto_queue_messages,
        persist_plan_history,
        updated_at
      FROM chat_settings
      WHERE chat_id = ?
    `).get(chatId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      chatId: String(row.chat_id),
      model: row.model === null ? null : String(row.model),
      reasoningEffort: row.reasoning_effort === null ? null : String(row.reasoning_effort) as ReasoningEffortValue,
      locale: row.locale === null ? null : String(row.locale) as AppLocale,
      accessPreset: row.access_preset === null ? null : String(row.access_preset) as AccessPresetValue,
      collaborationMode: row.collaboration_mode === null ? null : String(row.collaboration_mode) as CollaborationModeValue,
      confirmPlanBeforeExecute: Number(row.confirm_plan_before_execute) !== 0,
      autoQueueMessages: Number(row.auto_queue_messages) !== 0,
      persistPlanHistory: Number(row.persist_plan_history) !== 0,
      updatedAt: Number(row.updated_at),
    };
  }

  setChatSettings(chatId: string, model: string | null, reasoningEffort: ReasoningEffortValue | null, locale?: AppLocale | null): void {
    const current = this.getChatSettings(chatId);
    const nextLocale = locale === undefined ? current?.locale ?? null : locale;
    this.writeChatSettings(
      chatId,
      model,
      reasoningEffort,
      nextLocale,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      current?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute,
      current?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages,
      current?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory,
    );
  }

  setChatLocale(chatId: string, locale: AppLocale): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      locale,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      current?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute,
      current?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages,
      current?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory,
    );
  }

  setChatAccessPreset(chatId: string, accessPreset: AccessPresetValue | null): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      current?.locale ?? null,
      accessPreset,
      current?.collaborationMode ?? null,
      current?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute,
      current?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages,
      current?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory,
    );
  }

  setChatCollaborationMode(chatId: string, collaborationMode: CollaborationModeValue | null): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      current?.locale ?? null,
      current?.accessPreset ?? null,
      collaborationMode,
      current?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute,
      current?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages,
      current?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory,
    );
  }

  setChatGuidedPlanPreferences(
    chatId: string,
    updates: Partial<Pick<ChatSessionSettings, 'confirmPlanBeforeExecute' | 'autoQueueMessages' | 'persistPlanHistory'>>,
  ): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      current?.locale ?? null,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      updates.confirmPlanBeforeExecute ?? current?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute,
      updates.autoQueueMessages ?? current?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages,
      updates.persistPlanHistory ?? current?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory,
    );
  }

  findChatIdByThreadId(threadId: string): string | null {
    const row = this.db.prepare('SELECT chat_id FROM chat_bindings WHERE thread_id = ?').get(threadId) as { chat_id: string } | undefined;
    return row ? String(row.chat_id) : null;
  }

  countBindings(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM chat_bindings').get() as { count: number };
    return Number(row.count);
  }

  cacheThreadList(chatId: string, threads: Array<Omit<CachedThread, 'index'>>): void {
    const deleteStmt = this.db.prepare('DELETE FROM thread_cache WHERE chat_id = ?');
    const overrideStmt = this.db.prepare('SELECT custom_name FROM thread_name_overrides WHERE chat_id = ? AND thread_id = ?');
    const insertStmt = this.db.prepare(`
      INSERT INTO thread_cache (chat_id, idx, thread_id, name, preview, cwd, model_provider, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    deleteStmt.run(chatId);
    threads.forEach((thread, index) => {
      const override = overrideStmt.get(chatId, thread.threadId) as { custom_name: string } | undefined;
      insertStmt.run(
        chatId,
        index + 1,
        thread.threadId,
        override ? String(override.custom_name) : thread.name,
        thread.preview,
        thread.cwd,
        thread.modelProvider,
        thread.status,
        thread.updatedAt,
      );
    });
  }

  setThreadNameOverride(chatId: string, threadId: string, customName: string): void {
    const normalized = customName.trim();
    if (!normalized) {
      this.clearThreadNameOverride(chatId, threadId);
      return;
    }
    this.db.prepare(`
      INSERT INTO thread_name_overrides (chat_id, thread_id, custom_name, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, thread_id)
      DO UPDATE SET custom_name = excluded.custom_name, updated_at = excluded.updated_at
    `).run(chatId, threadId, normalized, Date.now());
    this.db.prepare(`
      UPDATE thread_cache
      SET name = ?
      WHERE chat_id = ? AND thread_id = ?
    `).run(normalized, chatId, threadId);
  }

  getThreadNameOverride(chatId: string, threadId: string): string | null {
    const row = this.db.prepare(`
      SELECT custom_name
      FROM thread_name_overrides
      WHERE chat_id = ? AND thread_id = ?
    `).get(chatId, threadId) as { custom_name: string } | undefined;
    return row ? String(row.custom_name) : null;
  }

  clearThreadNameOverride(chatId: string, threadId: string): void {
    this.db.prepare('DELETE FROM thread_name_overrides WHERE chat_id = ? AND thread_id = ?').run(chatId, threadId);
  }

  getCachedThread(chatId: string, index: number): CachedThread | null {
    const row = this.db.prepare(`
      SELECT idx, thread_id, name, preview, cwd, model_provider, status, updated_at
      FROM thread_cache
      WHERE chat_id = ? AND idx = ?
    `).get(chatId, index) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      index: Number(row.idx),
      threadId: String(row.thread_id),
      name: row.name === null ? null : String(row.name),
      preview: String(row.preview),
      cwd: row.cwd === null ? null : String(row.cwd),
      modelProvider: row.model_provider === null ? null : String(row.model_provider),
      status: String(row.status) as CachedThread['status'],
      updatedAt: Number(row.updated_at),
    };
  }

  listCachedThreads(chatId: string): CachedThread[] {
    const rows = this.db.prepare(`
      SELECT idx, thread_id, name, preview, cwd, model_provider, status, updated_at
      FROM thread_cache
      WHERE chat_id = ?
      ORDER BY idx ASC
    `).all(chatId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      index: Number(row.idx),
      threadId: String(row.thread_id),
      name: row.name === null ? null : String(row.name),
      preview: String(row.preview),
      cwd: row.cwd === null ? null : String(row.cwd),
      modelProvider: row.model_provider === null ? null : String(row.model_provider),
      status: String(row.status) as CachedThread['status'],
      updatedAt: Number(row.updated_at),
    }));
  }

  savePendingApproval(record: PendingApprovalRecord): void {
    this.db.prepare(`
      INSERT INTO pending_approvals (
        local_id, server_request_id, kind, chat_id, thread_id, turn_id, item_id, approval_id,
        reason, command, cwd, summary, risk_level, details_json, message_id, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.localId,
      record.serverRequestId,
      record.kind,
      record.chatId,
      record.threadId,
      record.turnId,
      record.itemId,
      record.approvalId,
      record.reason,
      record.command,
      record.cwd,
      record.summary,
      record.riskLevel,
      record.details === null ? null : JSON.stringify(record.details),
      record.messageId,
      record.createdAt,
      record.resolvedAt,
    );
  }

  updatePendingApprovalMessage(localId: string, messageId: number): void {
    this.db.prepare('UPDATE pending_approvals SET message_id = ? WHERE local_id = ?').run(messageId, localId);
  }

  getPendingApproval(localId: string): PendingApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM pending_approvals WHERE local_id = ?').get(localId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapApproval(row);
  }

  listPendingApprovals(chatId?: string): PendingApprovalRecord[] {
    const sql = chatId
      ? 'SELECT * FROM pending_approvals WHERE chat_id = ? AND resolved_at IS NULL ORDER BY created_at ASC'
      : 'SELECT * FROM pending_approvals WHERE resolved_at IS NULL ORDER BY created_at ASC';
    const rows = (chatId
      ? this.db.prepare(sql).all(chatId)
      : this.db.prepare(sql).all()) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapApproval(row));
  }

  markApprovalResolved(localId: string): void {
    this.db.prepare('UPDATE pending_approvals SET resolved_at = ? WHERE local_id = ?').run(Date.now(), localId);
  }

  countPendingApprovals(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM pending_approvals WHERE resolved_at IS NULL').get() as { count: number };
    return Number(row.count);
  }

  savePendingUserInput(record: PendingUserInputRecord): void {
    this.db.prepare(`
      INSERT INTO pending_user_inputs (
        local_id, server_request_id, chat_id, thread_id, turn_id, item_id, message_id,
        questions_json, answers_json, current_question_index, awaiting_free_text, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.localId,
      record.serverRequestId,
      record.chatId,
      record.threadId,
      record.turnId,
      record.itemId,
      record.messageId,
      JSON.stringify(record.questions),
      JSON.stringify(record.answers),
      record.currentQuestionIndex,
      record.awaitingFreeText ? 1 : 0,
      record.createdAt,
      record.resolvedAt,
    );
  }

  updatePendingUserInputMessage(localId: string, messageId: number): void {
    this.db.prepare('UPDATE pending_user_inputs SET message_id = ? WHERE local_id = ?').run(messageId, localId);
  }

  updatePendingUserInputState(
    localId: string,
    answers: Record<string, string[]>,
    currentQuestionIndex: number,
    awaitingFreeText: boolean,
  ): void {
    this.db.prepare(`
      UPDATE pending_user_inputs
      SET answers_json = ?, current_question_index = ?, awaiting_free_text = ?
      WHERE local_id = ?
    `).run(
      JSON.stringify(answers),
      currentQuestionIndex,
      awaitingFreeText ? 1 : 0,
      localId,
    );
  }

  getPendingUserInput(localId: string): PendingUserInputRecord | null {
    const row = this.db.prepare('SELECT * FROM pending_user_inputs WHERE local_id = ?').get(localId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapPendingUserInput(row);
  }

  getPendingUserInputForChat(chatId: string): PendingUserInputRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM pending_user_inputs
      WHERE chat_id = ? AND resolved_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1
    `).get(chatId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapPendingUserInput(row);
  }

  listPendingUserInputs(chatId?: string): PendingUserInputRecord[] {
    const sql = chatId
      ? 'SELECT * FROM pending_user_inputs WHERE chat_id = ? AND resolved_at IS NULL ORDER BY created_at ASC'
      : 'SELECT * FROM pending_user_inputs WHERE resolved_at IS NULL ORDER BY created_at ASC';
    const rows = (chatId
      ? this.db.prepare(sql).all(chatId)
      : this.db.prepare(sql).all()) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapPendingUserInput(row));
  }

  markPendingUserInputResolved(localId: string): void {
    this.db.prepare('UPDATE pending_user_inputs SET resolved_at = ? WHERE local_id = ?').run(Date.now(), localId);
  }

  countPendingUserInputs(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM pending_user_inputs WHERE resolved_at IS NULL').get() as { count: number };
    return Number(row.count);
  }

  savePendingUserInputMessage(record: PendingUserInputMessageRecord): void {
    this.db.prepare(`
      INSERT INTO pending_user_input_messages (input_local_id, question_index, message_id, message_kind, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(input_local_id, question_index, message_kind) DO UPDATE SET
        message_id = excluded.message_id,
        created_at = excluded.created_at
    `).run(
      record.inputLocalId,
      record.questionIndex,
      record.messageId,
      record.messageKind,
      record.createdAt,
    );
  }

  listPendingUserInputMessages(inputLocalId: string): PendingUserInputMessageRecord[] {
    const rows = this.db.prepare(`
      SELECT input_local_id, question_index, message_id, message_kind, created_at
      FROM pending_user_input_messages
      WHERE input_local_id = ?
      ORDER BY question_index ASC, created_at ASC
    `).all(inputLocalId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      inputLocalId: String(row.input_local_id),
      questionIndex: Number(row.question_index),
      messageId: Number(row.message_id),
      messageKind: String(row.message_kind) as PendingUserInputMessageKind,
      createdAt: Number(row.created_at),
    }));
  }

  savePlanSession(record: GuidedPlanSession): void {
    this.db.prepare(`
      INSERT INTO plan_sessions (
        session_id, chat_id, thread_id, source_turn_id, execution_turn_id, state, confirmation_required,
        confirmed_plan_version, latest_plan_version, current_prompt_id, current_approval_id, queue_depth,
        last_plan_message_id, last_prompt_message_id, last_approval_message_id, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        thread_id = excluded.thread_id,
        source_turn_id = excluded.source_turn_id,
        execution_turn_id = excluded.execution_turn_id,
        state = excluded.state,
        confirmation_required = excluded.confirmation_required,
        confirmed_plan_version = excluded.confirmed_plan_version,
        latest_plan_version = excluded.latest_plan_version,
        current_prompt_id = excluded.current_prompt_id,
        current_approval_id = excluded.current_approval_id,
        queue_depth = excluded.queue_depth,
        last_plan_message_id = excluded.last_plan_message_id,
        last_prompt_message_id = excluded.last_prompt_message_id,
        last_approval_message_id = excluded.last_approval_message_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at
    `).run(
      record.sessionId,
      record.chatId,
      record.threadId,
      record.sourceTurnId,
      record.executionTurnId,
      record.state,
      record.confirmationRequired ? 1 : 0,
      record.confirmedPlanVersion,
      record.latestPlanVersion,
      record.currentPromptId,
      record.currentApprovalId,
      record.queueDepth,
      record.lastPlanMessageId,
      record.lastPromptMessageId,
      record.lastApprovalMessageId,
      record.createdAt,
      record.updatedAt,
      record.resolvedAt,
    );
  }

  getPlanSession(sessionId: string): GuidedPlanSession | null {
    const row = this.db.prepare('SELECT * FROM plan_sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapPlanSession(row);
  }

  listOpenPlanSessions(chatId?: string): GuidedPlanSession[] {
    const sql = chatId
      ? 'SELECT * FROM plan_sessions WHERE resolved_at IS NULL AND chat_id = ? ORDER BY created_at ASC'
      : 'SELECT * FROM plan_sessions WHERE resolved_at IS NULL ORDER BY created_at ASC';
    const rows = (chatId
      ? this.db.prepare(sql).all(chatId)
      : this.db.prepare(sql).all()) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapPlanSession(row));
  }

  updatePlanSessionState(sessionId: string, state: GuidedPlanSessionState, resolvedAt: number | null = null): void {
    this.db.prepare(`
      UPDATE plan_sessions
      SET state = ?, resolved_at = ?, updated_at = ?
      WHERE session_id = ?
    `).run(state, resolvedAt, Date.now(), sessionId);
  }

  savePlanSnapshot(record: PlanSnapshotRecord): void {
    this.db.prepare(`
      INSERT INTO plan_snapshots (session_id, version, source_event, explanation, steps_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, version) DO UPDATE SET
        source_event = excluded.source_event,
        explanation = excluded.explanation,
        steps_json = excluded.steps_json,
        created_at = excluded.created_at
    `).run(
      record.sessionId,
      record.version,
      record.sourceEvent,
      record.explanation,
      JSON.stringify(record.steps),
      record.createdAt,
    );
  }

  listPlanSnapshots(sessionId: string): PlanSnapshotRecord[] {
    const rows = this.db.prepare(`
      SELECT session_id, version, source_event, explanation, steps_json, created_at
      FROM plan_snapshots
      WHERE session_id = ?
      ORDER BY version ASC
    `).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      version: Number(row.version),
      sourceEvent: String(row.source_event),
      explanation: row.explanation === null ? null : String(row.explanation),
      steps: parseJsonValue<PlanSnapshotStep[]>(row.steps_json, []),
      createdAt: Number(row.created_at),
    }));
  }

  requeueInterruptedQueuedTurnInputs(): number {
    const result = this.db.prepare(`
      UPDATE queued_turn_inputs
      SET status = 'queued', updated_at = ?
      WHERE status = 'processing'
    `).run(Date.now());
    return Number(result.changes ?? 0);
  }

  cleanupHistoricalRecords(options: HistoricalCleanupOptions): HistoricalCleanupResult {
    const cutoff = Date.now() - Math.max(0, options.maxResolvedAgeMs);
    const sessionIdsToDelete = this.collectResolvedPlanSessionIdsForCleanup(
      cutoff,
      Math.max(0, options.maxResolvedPlanSessionsPerChat),
    );
    const pendingUserInputIdsToDelete = this.collectPendingUserInputIdsForCleanup(cutoff);

    const deletedPlanSnapshots = this.deleteRowsByIds('plan_snapshots', 'session_id', sessionIdsToDelete);
    const deletedPlanSessions = this.deleteRowsByIds('plan_sessions', 'session_id', sessionIdsToDelete);
    const deletedPendingApprovals = Number(this.db.prepare(`
      DELETE FROM pending_approvals
      WHERE resolved_at IS NOT NULL AND resolved_at < ?
    `).run(cutoff).changes ?? 0);
    const deletedPendingUserInputMessages =
      this.deleteRowsByIds('pending_user_input_messages', 'input_local_id', pendingUserInputIdsToDelete)
      + Number(this.db.prepare(`
        DELETE FROM pending_user_input_messages
        WHERE input_local_id NOT IN (SELECT local_id FROM pending_user_inputs)
      `).run().changes ?? 0);
    const deletedPendingUserInputs = this.deleteRowsByIds('pending_user_inputs', 'local_id', pendingUserInputIdsToDelete);
    const deletedQueuedTurnInputs = Number(this.db.prepare(`
      DELETE FROM queued_turn_inputs
      WHERE status IN ('completed', 'cancelled', 'failed') AND updated_at < ?
    `).run(cutoff).changes ?? 0);

    return {
      deletedPlanSessions,
      deletedPlanSnapshots,
      deletedPendingApprovals,
      deletedPendingUserInputs,
      deletedPendingUserInputMessages,
      deletedQueuedTurnInputs,
    };
  }

  saveQueuedTurnInput(record: QueuedTurnInputRecord): void {
    this.db.prepare(`
      INSERT INTO queued_turn_inputs (
        queue_id, scope_id, chat_id, thread_id, input_json, source_summary, telegram_message_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(queue_id) DO UPDATE SET
        scope_id = excluded.scope_id,
        chat_id = excluded.chat_id,
        thread_id = excluded.thread_id,
        input_json = excluded.input_json,
        source_summary = excluded.source_summary,
        telegram_message_id = excluded.telegram_message_id,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      record.queueId,
      record.scopeId,
      record.chatId,
      record.threadId,
      JSON.stringify(record.input),
      record.sourceSummary,
      record.telegramMessageId,
      record.status,
      record.createdAt,
      record.updatedAt,
    );
  }

  getQueuedTurnInput(queueId: string): QueuedTurnInputRecord | null {
    const row = this.db.prepare('SELECT * FROM queued_turn_inputs WHERE queue_id = ?').get(queueId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapQueuedTurnInput(row);
  }

  listQueuedTurnInputs(scopeId?: string): QueuedTurnInputRecord[] {
    const sql = scopeId
      ? 'SELECT * FROM queued_turn_inputs WHERE scope_id = ? ORDER BY created_at ASC'
      : 'SELECT * FROM queued_turn_inputs ORDER BY created_at ASC';
    const rows = (scopeId
      ? this.db.prepare(sql).all(scopeId)
      : this.db.prepare(sql).all()) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapQueuedTurnInput(row));
  }

  peekQueuedTurnInput(scopeId: string): QueuedTurnInputRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM queued_turn_inputs
      WHERE scope_id = ? AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `).get(scopeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapQueuedTurnInput(row);
  }

  updateQueuedTurnInputStatus(queueId: string, status: QueuedTurnInputStatus): void {
    this.db.prepare(`
      UPDATE queued_turn_inputs
      SET status = ?, updated_at = ?
      WHERE queue_id = ?
    `).run(status, Date.now(), queueId);
  }

  countQueuedTurnInputs(scopeId?: string): number {
    const row = (scopeId
      ? this.db.prepare('SELECT COUNT(*) AS count FROM queued_turn_inputs WHERE scope_id = ? AND status = \'queued\'').get(scopeId)
      : this.db.prepare('SELECT COUNT(*) AS count FROM queued_turn_inputs WHERE status = \'queued\'').get()) as { count: number };
    return Number(row.count);
  }

  removeQueuedTurnInput(queueId: string): void {
    this.db.prepare('DELETE FROM queued_turn_inputs WHERE queue_id = ?').run(queueId);
  }

  saveActiveTurnPreview(record: Pick<ActiveTurnPreviewRecord, 'turnId' | 'scopeId' | 'threadId' | 'messageId'>): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM active_turn_previews WHERE turn_id = ? OR scope_id = ?').run(record.turnId, record.scopeId);
    this.db.prepare(`
      INSERT INTO active_turn_previews (turn_id, scope_id, thread_id, message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.turnId, record.scopeId, record.threadId, record.messageId, now, now);
  }

  listActiveTurnPreviews(): ActiveTurnPreviewRecord[] {
    const rows = this.db.prepare(`
      SELECT turn_id, scope_id, thread_id, message_id, created_at, updated_at
      FROM active_turn_previews
      ORDER BY created_at ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      turnId: String(row.turn_id),
      scopeId: String(row.scope_id),
      threadId: String(row.thread_id),
      messageId: Number(row.message_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  removeActiveTurnPreview(turnId: string): void {
    this.db.prepare('DELETE FROM active_turn_previews WHERE turn_id = ?').run(turnId);
  }

  removeActiveTurnPreviewByMessage(scopeId: string, messageId: number): void {
    this.db.prepare('DELETE FROM active_turn_previews WHERE scope_id = ? AND message_id = ?').run(scopeId, messageId);
  }

  saveThreadHistoryPreview(record: Pick<ThreadHistoryPreviewRecord, 'scopeId' | 'threadId' | 'messageId'>): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO thread_history_previews (scope_id, thread_id, message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        message_id = excluded.message_id,
        updated_at = excluded.updated_at
    `).run(record.scopeId, record.threadId, record.messageId, now, now);
  }

  getThreadHistoryPreview(scopeId: string): ThreadHistoryPreviewRecord | null {
    const row = this.db.prepare(`
      SELECT scope_id, thread_id, message_id, created_at, updated_at
      FROM thread_history_previews
      WHERE scope_id = ?
    `).get(scopeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      scopeId: String(row.scope_id),
      threadId: String(row.thread_id),
      messageId: Number(row.message_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  removeThreadHistoryPreview(scopeId: string): void {
    this.db.prepare('DELETE FROM thread_history_previews WHERE scope_id = ?').run(scopeId);
  }

  insertAudit(direction: 'inbound' | 'outbound', chatId: string, eventType: string, summary: string): void {
    this.db.prepare('INSERT INTO audit_logs (direction, chat_id, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(direction, chatId, eventType, summary, Date.now());
  }

  close(): void {
    this.db.close();
  }

  private mapApproval(row: Record<string, unknown>): PendingApprovalRecord {
    return {
      localId: String(row.local_id),
      serverRequestId: String(row.server_request_id),
      kind: row.kind === 'fileChange' ? 'fileChange' : 'command',
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      itemId: String(row.item_id),
      approvalId: row.approval_id === null ? null : String(row.approval_id),
      reason: row.reason === null ? null : String(row.reason),
      command: row.command === null ? null : String(row.command),
      cwd: row.cwd === null ? null : String(row.cwd),
      summary: row.summary === null ? null : String(row.summary),
      riskLevel: row.risk_level === null ? null : String(row.risk_level) as PendingApprovalRecord['riskLevel'],
      details: parseJsonValue<Record<string, unknown> | null>(row.details_json, null),
      messageId: row.message_id === null ? null : Number(row.message_id),
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at)
    };
  }

  private mapPendingUserInput(row: Record<string, unknown>): PendingUserInputRecord {
    return {
      localId: String(row.local_id),
      serverRequestId: String(row.server_request_id),
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      itemId: String(row.item_id),
      messageId: row.message_id === null ? null : Number(row.message_id),
      questions: parseJsonValue<PendingUserInputQuestion[]>(row.questions_json, []),
      answers: parseJsonValue<Record<string, string[]>>(row.answers_json, {}),
      currentQuestionIndex: Number(row.current_question_index),
      awaitingFreeText: Number(row.awaiting_free_text) === 1,
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }

  private mapPlanSession(row: Record<string, unknown>): GuidedPlanSession {
    return {
      sessionId: String(row.session_id),
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      sourceTurnId: row.source_turn_id === null ? null : String(row.source_turn_id),
      executionTurnId: row.execution_turn_id === null ? null : String(row.execution_turn_id),
      state: String(row.state) as GuidedPlanSessionState,
      confirmationRequired: Number(row.confirmation_required) !== 0,
      confirmedPlanVersion: row.confirmed_plan_version === null ? null : Number(row.confirmed_plan_version),
      latestPlanVersion: row.latest_plan_version === null ? null : Number(row.latest_plan_version),
      currentPromptId: row.current_prompt_id === null ? null : String(row.current_prompt_id),
      currentApprovalId: row.current_approval_id === null ? null : String(row.current_approval_id),
      queueDepth: Number(row.queue_depth),
      lastPlanMessageId: row.last_plan_message_id === null ? null : Number(row.last_plan_message_id),
      lastPromptMessageId: row.last_prompt_message_id === null ? null : Number(row.last_prompt_message_id),
      lastApprovalMessageId: row.last_approval_message_id === null ? null : Number(row.last_approval_message_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }

  private mapQueuedTurnInput(row: Record<string, unknown>): QueuedTurnInputRecord {
    return {
      queueId: String(row.queue_id),
      scopeId: String(row.scope_id),
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      input: parseJsonValue<unknown[]>(row.input_json, []),
      sourceSummary: String(row.source_summary),
      telegramMessageId: row.telegram_message_id === null ? null : Number(row.telegram_message_id),
      status: String(row.status) as QueuedTurnInputStatus,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private writeChatSettings(
    chatId: string,
    model: string | null,
    reasoningEffort: ReasoningEffortValue | null,
    locale: AppLocale | null,
    accessPreset: AccessPresetValue | null,
    collaborationMode: CollaborationModeValue | null,
    confirmPlanBeforeExecute: boolean,
    autoQueueMessages: boolean,
    persistPlanHistory: boolean,
  ): void {
    this.db.prepare(`
      INSERT INTO chat_settings (
        chat_id, model, reasoning_effort, locale, access_preset, collaboration_mode,
        confirm_plan_before_execute, auto_queue_messages, persist_plan_history, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        locale = excluded.locale,
        access_preset = excluded.access_preset,
        collaboration_mode = excluded.collaboration_mode,
        confirm_plan_before_execute = excluded.confirm_plan_before_execute,
        auto_queue_messages = excluded.auto_queue_messages,
        persist_plan_history = excluded.persist_plan_history,
        updated_at = excluded.updated_at
    `).run(
      chatId,
      model,
      reasoningEffort,
      locale,
      accessPreset,
      collaborationMode,
      confirmPlanBeforeExecute ? 1 : 0,
      autoQueueMessages ? 1 : 0,
      persistPlanHistory ? 1 : 0,
      Date.now(),
    );
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some(entry => entry.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private collectResolvedPlanSessionIdsForCleanup(cutoff: number, maxResolvedPlanSessionsPerChat: number): string[] {
    const disabledChatRows = this.db.prepare(`
      SELECT chat_id
      FROM chat_settings
      WHERE persist_plan_history = 0
    `).all() as Array<{ chat_id: string }>;
    const disabledChatIds = new Set(disabledChatRows.map((row) => String(row.chat_id)));
    const rows = this.db.prepare(`
      SELECT session_id, chat_id, resolved_at
      FROM plan_sessions
      WHERE resolved_at IS NOT NULL
      ORDER BY chat_id ASC, resolved_at DESC, created_at DESC, session_id ASC
    `).all() as Array<Record<string, unknown>>;
    const keptByChat = new Map<string, number>();
    const sessionIdsToDelete: string[] = [];
    for (const row of rows) {
      const sessionId = String(row.session_id);
      const chatId = String(row.chat_id);
      const resolvedAt = Number(row.resolved_at);
      if (disabledChatIds.has(chatId) || resolvedAt < cutoff) {
        sessionIdsToDelete.push(sessionId);
        continue;
      }
      const kept = keptByChat.get(chatId) ?? 0;
      if (kept >= maxResolvedPlanSessionsPerChat) {
        sessionIdsToDelete.push(sessionId);
        continue;
      }
      keptByChat.set(chatId, kept + 1);
    }
    return sessionIdsToDelete;
  }

  private collectPendingUserInputIdsForCleanup(cutoff: number): string[] {
    const rows = this.db.prepare(`
      SELECT local_id
      FROM pending_user_inputs
      WHERE resolved_at IS NOT NULL AND resolved_at < ?
    `).all(cutoff) as Array<{ local_id: string }>;
    return rows.map((row) => String(row.local_id));
  }

  private deleteRowsByIds(table: string, column: string, ids: string[]): number {
    if (ids.length === 0) {
      return 0;
    }
    const placeholders = ids.map(() => '?').join(', ');
    const result = this.db.prepare(`
      DELETE FROM ${table}
      WHERE ${column} IN (${placeholders})
    `).run(...ids);
    return Number(result.changes ?? 0);
  }
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
