import { DEFAULT_GUIDED_PLAN_PREFERENCES } from '../types.js';
import type {
  AccessPresetValue,
  AppLocale,
  CachedThread,
  ChatSessionSettings,
  CollaborationModeValue,
  GeminiApprovalModeValue,
  ReasoningEffortValue,
  ServiceTierValue,
  ThreadBinding,
} from '../types.js';
import type { SqliteDatabase } from './sqlite.js';
import type { SqliteRow } from './shared.js';

export class ChatStateRepository {
  constructor(private readonly db: SqliteDatabase) {}

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
    const row = this.db.prepare('SELECT chat_id, thread_id, cwd, updated_at FROM chat_bindings WHERE chat_id = ?').get(chatId) as SqliteRow | undefined;
    if (!row) {
      return null;
    }
    return {
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      cwd: row.cwd === null ? null : String(row.cwd),
      updatedAt: Number(row.updated_at),
    };
  }

  setBinding(chatId: string, threadId: string, cwd: string | null): void {
    this.db.prepare(`
      INSERT INTO chat_bindings (chat_id, thread_id, cwd, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET thread_id = excluded.thread_id, cwd = excluded.cwd, updated_at = excluded.updated_at
    `).run(chatId, threadId, cwd, Date.now());
  }

  findChatIdByThreadId(threadId: string): string | null {
    const row = this.db.prepare('SELECT chat_id FROM chat_bindings WHERE thread_id = ?').get(threadId) as { chat_id: string } | undefined;
    return row ? String(row.chat_id) : null;
  }

  countBindings(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM chat_bindings').get() as { count: number };
    return Number(row.count);
  }

  getChatSettings(chatId: string): ChatSessionSettings | null {
    const row = this.db.prepare(`
      SELECT
        chat_id,
        model,
        reasoning_effort,
        model_variant,
        service_tier,
        locale,
        access_preset,
        collaboration_mode,
        gemini_approval_mode,
        confirm_plan_before_execute,
        auto_queue_messages,
        persist_plan_history,
        updated_at
      FROM chat_settings
      WHERE chat_id = ?
    `).get(chatId) as SqliteRow | undefined;
    if (!row) {
      return null;
    }
    return {
      chatId: String(row.chat_id),
      model: row.model === null ? null : String(row.model),
      reasoningEffort: row.reasoning_effort === null ? null : String(row.reasoning_effort) as ReasoningEffortValue,
      modelVariant: row.model_variant === null ? null : String(row.model_variant),
      serviceTier: row.service_tier === null ? null : String(row.service_tier) as ServiceTierValue,
      locale: row.locale === null ? null : String(row.locale) as AppLocale,
      accessPreset: row.access_preset === null ? null : String(row.access_preset) as AccessPresetValue,
      collaborationMode: row.collaboration_mode === null ? null : String(row.collaboration_mode) as CollaborationModeValue,
      geminiApprovalMode: row.gemini_approval_mode === null ? null : String(row.gemini_approval_mode) as GeminiApprovalModeValue,
      confirmPlanBeforeExecute: Number(row.confirm_plan_before_execute) !== 0,
      autoQueueMessages: Number(row.auto_queue_messages) !== 0,
      persistPlanHistory: Number(row.persist_plan_history) !== 0,
      updatedAt: Number(row.updated_at),
    };
  }

  setChatSettings(
    chatId: string,
    model: string | null,
    reasoningEffort: ReasoningEffortValue | null,
    locale?: AppLocale | null,
    modelVariant?: string | null,
  ): void {
    const current = this.getChatSettings(chatId);
    const nextLocale = locale === undefined ? current?.locale ?? null : locale;
    this.writeChatSettings(
      chatId,
      model,
      reasoningEffort,
      modelVariant === undefined ? current?.modelVariant ?? null : modelVariant,
      current?.serviceTier ?? null,
      nextLocale,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      current?.geminiApprovalMode ?? null,
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
      current?.modelVariant ?? null,
      current?.serviceTier ?? null,
      locale,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      current?.geminiApprovalMode ?? null,
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
      current?.modelVariant ?? null,
      current?.serviceTier ?? null,
      current?.locale ?? null,
      accessPreset,
      current?.collaborationMode ?? null,
      current?.geminiApprovalMode ?? null,
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
      current?.modelVariant ?? null,
      current?.serviceTier ?? null,
      current?.locale ?? null,
      current?.accessPreset ?? null,
      collaborationMode,
      current?.geminiApprovalMode ?? null,
      current?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute,
      current?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages,
      current?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory,
    );
  }

  setChatGeminiApprovalMode(chatId: string, geminiApprovalMode: GeminiApprovalModeValue | null): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      current?.modelVariant ?? null,
      current?.serviceTier ?? null,
      current?.locale ?? null,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      geminiApprovalMode,
      current?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute,
      current?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages,
      current?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory,
    );
  }

  setChatServiceTier(chatId: string, serviceTier: ServiceTierValue | null): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      current?.modelVariant ?? null,
      serviceTier,
      current?.locale ?? null,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      current?.geminiApprovalMode ?? null,
      current?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute,
      current?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages,
      current?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory,
    );
  }

  setChatModelVariant(chatId: string, modelVariant: string | null): void {
    const current = this.getChatSettings(chatId);
    this.writeChatSettings(
      chatId,
      current?.model ?? null,
      current?.reasoningEffort ?? null,
      modelVariant,
      current?.serviceTier ?? null,
      current?.locale ?? null,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      current?.geminiApprovalMode ?? null,
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
      current?.modelVariant ?? null,
      current?.serviceTier ?? null,
      current?.locale ?? null,
      current?.accessPreset ?? null,
      current?.collaborationMode ?? null,
      current?.geminiApprovalMode ?? null,
      updates.confirmPlanBeforeExecute ?? current?.confirmPlanBeforeExecute ?? DEFAULT_GUIDED_PLAN_PREFERENCES.confirmPlanBeforeExecute,
      updates.autoQueueMessages ?? current?.autoQueueMessages ?? DEFAULT_GUIDED_PLAN_PREFERENCES.autoQueueMessages,
      updates.persistPlanHistory ?? current?.persistPlanHistory ?? DEFAULT_GUIDED_PLAN_PREFERENCES.persistPlanHistory,
    );
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
    `).get(chatId, index) as SqliteRow | undefined;
    if (!row) {
      return null;
    }
    return this.mapCachedThread(row);
  }

  listCachedThreads(chatId: string): CachedThread[] {
    const rows = this.db.prepare(`
      SELECT idx, thread_id, name, preview, cwd, model_provider, status, updated_at
      FROM thread_cache
      WHERE chat_id = ?
      ORDER BY idx ASC
    `).all(chatId) as SqliteRow[];
    return rows.map((row) => this.mapCachedThread(row));
  }

  insertAudit(direction: 'inbound' | 'outbound', chatId: string, eventType: string, summary: string): void {
    this.db.prepare(`
      INSERT INTO audit_logs (direction, chat_id, event_type, summary, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(direction, chatId, eventType, summary, Date.now());
  }

  private mapCachedThread(row: SqliteRow): CachedThread {
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

  private writeChatSettings(
    chatId: string,
    model: string | null,
    reasoningEffort: ReasoningEffortValue | null,
    modelVariant: string | null,
    serviceTier: ServiceTierValue | null,
    locale: AppLocale | null,
    accessPreset: AccessPresetValue | null,
    collaborationMode: CollaborationModeValue | null,
    geminiApprovalMode: GeminiApprovalModeValue | null,
    confirmPlanBeforeExecute: boolean,
    autoQueueMessages: boolean,
    persistPlanHistory: boolean,
  ): void {
    this.db.prepare(`
      INSERT INTO chat_settings (
        chat_id, model, reasoning_effort, model_variant, service_tier, locale, access_preset, collaboration_mode,
        gemini_approval_mode, confirm_plan_before_execute, auto_queue_messages, persist_plan_history, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        model_variant = excluded.model_variant,
        service_tier = excluded.service_tier,
        locale = excluded.locale,
        access_preset = excluded.access_preset,
        collaboration_mode = excluded.collaboration_mode,
        gemini_approval_mode = excluded.gemini_approval_mode,
        confirm_plan_before_execute = excluded.confirm_plan_before_execute,
        auto_queue_messages = excluded.auto_queue_messages,
        persist_plan_history = excluded.persist_plan_history,
        updated_at = excluded.updated_at
    `).run(
      chatId,
      model,
      reasoningEffort,
      modelVariant,
      serviceTier,
      locale,
      accessPreset,
      collaborationMode,
      geminiApprovalMode,
      confirmPlanBeforeExecute ? 1 : 0,
      autoQueueMessages ? 1 : 0,
      persistPlanHistory ? 1 : 0,
      Date.now(),
    );
  }
}
