import fs from 'node:fs';
import path from 'node:path';
import type {
  AccessPresetValue,
  AppLocale,
  CachedThread,
  ChatSessionSettings,
  CollaborationModeValue,
  GeminiApprovalModeValue,
  GuidedPlanSession,
  GuidedPlanSessionState,
  PendingAttachmentBatchRecord,
  PendingApprovalRecord,
  PendingUserInputMessageRecord,
  PendingUserInputRecord,
  PlanSnapshotRecord,
  QueuedTurnInputRecord,
  QueuedTurnInputStatus,
  ReasoningEffortValue,
  ServiceTierValue,
  ThreadBinding,
} from '../types.js';
import { AttachmentStateRepository } from './attachment_state_repository.js';
import { ChatStateRepository } from './chat_state_repository.js';
import { PlanStateRepository } from './plan_state_repository.js';
import { PreviewStateRepository } from './preview_state_repository.js';
import { QueueStateRepository } from './queue_state_repository.js';
export type {
  ActiveTurnPreviewRecord,
  HistoricalCleanupOptions,
  HistoricalCleanupResult,
  ThreadHistoryPreviewRecord,
} from './records.js';
import type {
  ActiveTurnPreviewRecord,
  HistoricalCleanupOptions,
  HistoricalCleanupResult,
  ThreadHistoryPreviewRecord,
} from './records.js';
import { initializeBridgeStoreSchema } from './schema.js';
import { openSqliteDatabase, type SqliteDatabase } from './sqlite.js';
import { WorkflowStateRepository } from './workflow_state_repository.js';

export class BridgeStore {
  private readonly db: SqliteDatabase;
  private readonly chatState: ChatStateRepository;
  private readonly attachments: AttachmentStateRepository;
  private readonly workflow: WorkflowStateRepository;
  private readonly plans: PlanStateRepository;
  private readonly queue: QueueStateRepository;
  private readonly previews: PreviewStateRepository;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = openSqliteDatabase(dbPath);
    initializeBridgeStoreSchema(this.db);
    this.chatState = new ChatStateRepository(this.db);
    this.attachments = new AttachmentStateRepository(this.db);
    this.workflow = new WorkflowStateRepository(this.db);
    this.plans = new PlanStateRepository(this.db);
    this.queue = new QueueStateRepository(this.db);
    this.previews = new PreviewStateRepository(this.db);
  }

  getTelegramOffset(botKey: string): number {
    return this.chatState.getTelegramOffset(botKey);
  }

  setTelegramOffset(botKey: string, updateId: number): void {
    this.chatState.setTelegramOffset(botKey, updateId);
  }

  getBinding(chatId: string): ThreadBinding | null {
    return this.chatState.getBinding(chatId);
  }

  setBinding(chatId: string, threadId: string, cwd: string | null): void {
    this.chatState.setBinding(chatId, threadId, cwd);
  }

  getChatSettings(chatId: string): ChatSessionSettings | null {
    return this.chatState.getChatSettings(chatId);
  }

  setChatSettings(
    chatId: string,
    model: string | null,
    reasoningEffort: ReasoningEffortValue | null,
    locale?: AppLocale | null,
    modelVariant?: string | null,
  ): void {
    this.chatState.setChatSettings(chatId, model, reasoningEffort, locale, modelVariant);
  }

  setChatLocale(chatId: string, locale: AppLocale): void {
    this.chatState.setChatLocale(chatId, locale);
  }

  setChatAccessPreset(chatId: string, accessPreset: AccessPresetValue | null): void {
    this.chatState.setChatAccessPreset(chatId, accessPreset);
  }

  setChatCollaborationMode(chatId: string, collaborationMode: CollaborationModeValue | null): void {
    this.chatState.setChatCollaborationMode(chatId, collaborationMode);
  }

  setChatGeminiApprovalMode(chatId: string, geminiApprovalMode: GeminiApprovalModeValue | null): void {
    this.chatState.setChatGeminiApprovalMode(chatId, geminiApprovalMode);
  }

  setChatServiceTier(chatId: string, serviceTier: ServiceTierValue | null): void {
    this.chatState.setChatServiceTier(chatId, serviceTier);
  }

  setChatModelVariant(chatId: string, modelVariant: string | null): void {
    this.chatState.setChatModelVariant(chatId, modelVariant);
  }

  setChatGuidedPlanPreferences(
    chatId: string,
    updates: Partial<Pick<ChatSessionSettings, 'confirmPlanBeforeExecute' | 'autoQueueMessages' | 'persistPlanHistory'>>,
  ): void {
    this.chatState.setChatGuidedPlanPreferences(chatId, updates);
  }

  findChatIdByThreadId(threadId: string): string | null {
    return this.chatState.findChatIdByThreadId(threadId);
  }

  countBindings(): number {
    return this.chatState.countBindings();
  }

  cacheThreadList(chatId: string, threads: Array<Omit<CachedThread, 'index'>>): void {
    this.chatState.cacheThreadList(chatId, threads);
  }

  setThreadNameOverride(chatId: string, threadId: string, customName: string): void {
    this.chatState.setThreadNameOverride(chatId, threadId, customName);
  }

  getThreadNameOverride(chatId: string, threadId: string): string | null {
    return this.chatState.getThreadNameOverride(chatId, threadId);
  }

  clearThreadNameOverride(chatId: string, threadId: string): void {
    this.chatState.clearThreadNameOverride(chatId, threadId);
  }

  getCachedThread(chatId: string, index: number): CachedThread | null {
    return this.chatState.getCachedThread(chatId, index);
  }

  listCachedThreads(chatId: string): CachedThread[] {
    return this.chatState.listCachedThreads(chatId);
  }

  savePendingApproval(record: PendingApprovalRecord): void {
    this.workflow.savePendingApproval(record);
  }

  savePendingAttachmentBatch(record: PendingAttachmentBatchRecord): void {
    this.attachments.savePendingAttachmentBatch(record);
  }

  getPendingAttachmentBatch(batchId: string): PendingAttachmentBatchRecord | null {
    return this.attachments.getPendingAttachmentBatch(batchId);
  }

  getLatestPendingAttachmentBatch(scopeId: string): PendingAttachmentBatchRecord | null {
    return this.attachments.getLatestPendingAttachmentBatch(scopeId);
  }

  getPendingAttachmentBatchByMediaGroup(scopeId: string, mediaGroupId: string): PendingAttachmentBatchRecord | null {
    return this.attachments.getPendingAttachmentBatchByMediaGroup(scopeId, mediaGroupId);
  }

  listPendingAttachmentBatches(scopeId?: string): PendingAttachmentBatchRecord[] {
    return this.attachments.listPendingAttachmentBatches(scopeId);
  }

  updatePendingAttachmentBatchReceipt(batchId: string, receiptMessageId: number): void {
    this.attachments.updatePendingAttachmentBatchReceipt(batchId, receiptMessageId);
  }

  resolvePendingAttachmentBatch(
    batchId: string,
    status: Exclude<PendingAttachmentBatchRecord['status'], 'pending'>,
  ): void {
    this.attachments.resolvePendingAttachmentBatch(batchId, status);
  }

  countPendingAttachmentBatches(scopeId?: string): number {
    return this.attachments.countPendingAttachmentBatches(scopeId);
  }

  updatePendingApprovalMessage(localId: string, messageId: number): void {
    this.workflow.updatePendingApprovalMessage(localId, messageId);
  }

  getPendingApproval(localId: string): PendingApprovalRecord | null {
    return this.workflow.getPendingApproval(localId);
  }

  listPendingApprovals(chatId?: string): PendingApprovalRecord[] {
    return this.workflow.listPendingApprovals(chatId);
  }

  markApprovalResolved(localId: string): void {
    this.workflow.markApprovalResolved(localId);
  }

  countPendingApprovals(): number {
    return this.workflow.countPendingApprovals();
  }

  savePendingUserInput(record: PendingUserInputRecord): void {
    this.workflow.savePendingUserInput(record);
  }

  updatePendingUserInputMessage(localId: string, messageId: number): void {
    this.workflow.updatePendingUserInputMessage(localId, messageId);
  }

  updatePendingUserInputState(
    localId: string,
    answers: Record<string, string[]>,
    currentQuestionIndex: number,
    awaitingFreeText: boolean,
  ): void {
    this.workflow.updatePendingUserInputState(localId, answers, currentQuestionIndex, awaitingFreeText);
  }

  getPendingUserInput(localId: string): PendingUserInputRecord | null {
    return this.workflow.getPendingUserInput(localId);
  }

  getPendingUserInputForChat(chatId: string): PendingUserInputRecord | null {
    return this.workflow.getPendingUserInputForChat(chatId);
  }

  listPendingUserInputs(chatId?: string): PendingUserInputRecord[] {
    return this.workflow.listPendingUserInputs(chatId);
  }

  markPendingUserInputResolved(localId: string): void {
    this.workflow.markPendingUserInputResolved(localId);
  }

  countPendingUserInputs(): number {
    return this.workflow.countPendingUserInputs();
  }

  savePendingUserInputMessage(record: PendingUserInputMessageRecord): void {
    this.workflow.savePendingUserInputMessage(record);
  }

  listPendingUserInputMessages(inputLocalId: string): PendingUserInputMessageRecord[] {
    return this.workflow.listPendingUserInputMessages(inputLocalId);
  }

  savePlanSession(record: GuidedPlanSession): void {
    this.plans.savePlanSession(record);
  }

  getPlanSession(sessionId: string): GuidedPlanSession | null {
    return this.plans.getPlanSession(sessionId);
  }

  listOpenPlanSessions(chatId?: string): GuidedPlanSession[] {
    return this.plans.listOpenPlanSessions(chatId);
  }

  updatePlanSessionState(sessionId: string, state: GuidedPlanSessionState, resolvedAt: number | null = null): void {
    this.plans.updatePlanSessionState(sessionId, state, resolvedAt);
  }

  cancelOpenPlanSessions(chatId: string, states: GuidedPlanSessionState[]): number {
    return this.plans.cancelOpenPlanSessions(chatId, states);
  }

  savePlanSnapshot(record: PlanSnapshotRecord): void {
    this.plans.savePlanSnapshot(record);
  }

  listPlanSnapshots(sessionId: string): PlanSnapshotRecord[] {
    return this.plans.listPlanSnapshots(sessionId);
  }

  requeueInterruptedQueuedTurnInputs(): number {
    return this.queue.requeueInterruptedQueuedTurnInputs();
  }

  cleanupHistoricalRecords(options: HistoricalCleanupOptions): HistoricalCleanupResult {
    const cutoff = Date.now() - Math.max(0, options.maxResolvedAgeMs);
    const sessionIdsToDelete = this.plans.collectResolvedPlanSessionIdsForCleanup(
      cutoff,
      Math.max(0, options.maxResolvedPlanSessionsPerChat),
    );
    const pendingUserInputIdsToDelete = this.workflow.collectPendingUserInputIdsForCleanup(cutoff);

    return {
      deletedPlanSessions: this.plans.deletePlanSessionsByIds(sessionIdsToDelete),
      deletedPlanSnapshots: this.plans.deletePlanSnapshotsBySessionIds(sessionIdsToDelete),
      deletedPendingApprovals: this.workflow.deleteResolvedApprovalsBefore(cutoff),
      deletedPendingUserInputs: this.workflow.deletePendingUserInputsByIds(pendingUserInputIdsToDelete),
      deletedPendingUserInputMessages:
        this.workflow.deletePendingUserInputMessagesByInputIds(pendingUserInputIdsToDelete)
        + this.workflow.deleteOrphanedPendingUserInputMessages(),
      deletedPendingAttachmentBatches: this.attachments.deleteResolvedPendingAttachmentBatchesBefore(cutoff),
      deletedQueuedTurnInputs: this.queue.deleteHistoricalQueuedTurnInputs(cutoff),
    };
  }

  saveQueuedTurnInput(record: QueuedTurnInputRecord): void {
    this.queue.saveQueuedTurnInput(record);
  }

  getQueuedTurnInput(queueId: string): QueuedTurnInputRecord | null {
    return this.queue.getQueuedTurnInput(queueId);
  }

  listQueuedTurnInputs(scopeId?: string): QueuedTurnInputRecord[] {
    return this.queue.listQueuedTurnInputs(scopeId);
  }

  peekQueuedTurnInput(scopeId: string): QueuedTurnInputRecord | null {
    return this.queue.peekQueuedTurnInput(scopeId);
  }

  updateQueuedTurnInputStatus(queueId: string, status: QueuedTurnInputStatus): void {
    this.queue.updateQueuedTurnInputStatus(queueId, status);
  }

  countQueuedTurnInputs(scopeId?: string): number {
    return this.queue.countQueuedTurnInputs(scopeId);
  }

  removeQueuedTurnInput(queueId: string): void {
    this.queue.removeQueuedTurnInput(queueId);
  }

  saveActiveTurnPreview(record: Pick<ActiveTurnPreviewRecord, 'turnId' | 'scopeId' | 'threadId' | 'messageId'>): void {
    this.previews.saveActiveTurnPreview(record);
  }

  listActiveTurnPreviews(): ActiveTurnPreviewRecord[] {
    return this.previews.listActiveTurnPreviews();
  }

  removeActiveTurnPreview(turnId: string): void {
    this.previews.removeActiveTurnPreview(turnId);
  }

  removeActiveTurnPreviewByMessage(scopeId: string, messageId: number): void {
    this.previews.removeActiveTurnPreviewByMessage(scopeId, messageId);
  }

  saveThreadHistoryPreview(record: Pick<ThreadHistoryPreviewRecord, 'scopeId' | 'threadId' | 'messageId'>): void {
    this.previews.saveThreadHistoryPreview(record);
  }

  getThreadHistoryPreview(scopeId: string): ThreadHistoryPreviewRecord | null {
    return this.previews.getThreadHistoryPreview(scopeId);
  }

  removeThreadHistoryPreview(scopeId: string): void {
    this.previews.removeThreadHistoryPreview(scopeId);
  }

  insertAudit(direction: 'inbound' | 'outbound', chatId: string, eventType: string, summary: string): void {
    this.chatState.insertAudit(direction, chatId, eventType, summary);
  }

  close(): void {
    this.db.close();
  }
}
