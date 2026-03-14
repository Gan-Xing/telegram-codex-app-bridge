import type {
  GuidedPlanSession,
  GuidedPlanSessionState,
  PlanSnapshotRecord,
  PlanSnapshotStep,
} from '../types.js';
import type { SqliteDatabase } from './sqlite.js';
import { deleteRowsByIds, parseJsonValue, type SqliteRow } from './shared.js';

export class PlanStateRepository {
  constructor(private readonly db: SqliteDatabase) {}

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
    const row = this.db.prepare('SELECT * FROM plan_sessions WHERE session_id = ?').get(sessionId) as SqliteRow | undefined;
    return row ? this.mapPlanSession(row) : null;
  }

  listOpenPlanSessions(chatId?: string): GuidedPlanSession[] {
    const sql = chatId
      ? 'SELECT * FROM plan_sessions WHERE resolved_at IS NULL AND chat_id = ? ORDER BY created_at ASC'
      : 'SELECT * FROM plan_sessions WHERE resolved_at IS NULL ORDER BY created_at ASC';
    const rows = (chatId
      ? this.db.prepare(sql).all(chatId)
      : this.db.prepare(sql).all()) as SqliteRow[];
    return rows.map((row) => this.mapPlanSession(row));
  }

  updatePlanSessionState(sessionId: string, state: GuidedPlanSessionState, resolvedAt: number | null = null): void {
    this.db.prepare(`
      UPDATE plan_sessions
      SET state = ?, resolved_at = ?, updated_at = ?
      WHERE session_id = ?
    `).run(state, resolvedAt, Date.now(), sessionId);
  }

  cancelOpenPlanSessions(chatId: string, states: GuidedPlanSessionState[]): number {
    if (states.length === 0) {
      return 0;
    }
    const placeholders = states.map(() => '?').join(', ');
    const resolvedAt = Date.now();
    const result = this.db.prepare(`
      UPDATE plan_sessions
      SET state = ?, resolved_at = ?, updated_at = ?
      WHERE chat_id = ?
        AND resolved_at IS NULL
        AND state IN (${placeholders})
    `).run('cancelled', resolvedAt, resolvedAt, chatId, ...states);
    return Number(result.changes ?? 0);
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
    `).all(sessionId) as SqliteRow[];
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      version: Number(row.version),
      sourceEvent: String(row.source_event),
      explanation: row.explanation === null ? null : String(row.explanation),
      steps: parseJsonValue<PlanSnapshotStep[]>(row.steps_json, []),
      createdAt: Number(row.created_at),
    }));
  }

  collectResolvedPlanSessionIdsForCleanup(cutoff: number, maxResolvedPlanSessionsPerChat: number): string[] {
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
    `).all() as SqliteRow[];
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

  deletePlanSnapshotsBySessionIds(sessionIds: string[]): number {
    return deleteRowsByIds(this.db, 'plan_snapshots', 'session_id', sessionIds);
  }

  deletePlanSessionsByIds(sessionIds: string[]): number {
    return deleteRowsByIds(this.db, 'plan_sessions', 'session_id', sessionIds);
  }

  private mapPlanSession(row: SqliteRow): GuidedPlanSession {
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
}
