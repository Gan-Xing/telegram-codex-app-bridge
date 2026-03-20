export interface ThreadBinding {
  chatId: string;
  threadId: string;
  cwd: string | null;
  updatedAt: number;
}

export type AppLocale = 'en' | 'zh' | 'fr';
export type ApprovalPolicyValue = 'on-request' | 'on-failure' | 'never' | 'untrusted';
export type SandboxModeValue = 'read-only' | 'workspace-write' | 'danger-full-access';
export type AccessPresetValue = 'read-only' | 'default' | 'full-access';
export type ReasoningEffortValue = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ServiceTierValue = 'fast' | 'flex';
export type CollaborationModeValue = 'default' | 'plan';
export type GeminiApprovalModeValue = 'default' | 'auto_edit' | 'yolo' | 'plan';
export type ThreadStatusKind = 'active' | 'idle' | 'notLoaded' | 'systemError';
export type ApprovalRiskLevel = 'low' | 'medium' | 'high';
export type GuidedPlanSessionState =
  | 'drafting_plan'
  | 'awaiting_plan_confirmation'
  | 'executing_confirmed_plan'
  | 'awaiting_followup_input'
  | 'awaiting_approval'
  | 'queued_follow_up_present'
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'recovery_required';
export type QueuedTurnInputStatus = 'queued' | 'processing' | 'completed' | 'cancelled' | 'failed';
export type PendingUserInputMessageKind = 'question' | 'review' | 'resolved';
export type PendingAttachmentBatchStatus = 'pending' | 'consumed' | 'cleared' | 'superseded';

export interface GuidedPlanPreferences {
  confirmPlanBeforeExecute: boolean;
  autoQueueMessages: boolean;
  persistPlanHistory: boolean;
}

export const DEFAULT_GUIDED_PLAN_PREFERENCES: GuidedPlanPreferences = {
  confirmPlanBeforeExecute: true,
  autoQueueMessages: true,
  persistPlanHistory: true,
};

export interface ChatSessionSettings extends GuidedPlanPreferences {
  chatId: string;
  model: string | null;
  reasoningEffort: ReasoningEffortValue | null;
  serviceTier: ServiceTierValue | null;
  locale: AppLocale | null;
  accessPreset: AccessPresetValue | null;
  collaborationMode: CollaborationModeValue | null;
  geminiApprovalMode?: GeminiApprovalModeValue | null;
  updatedAt: number;
}

export interface CachedThread {
  index: number;
  threadId: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  modelProvider: string | null;
  status: ThreadStatusKind;
  updatedAt: number;
}

export interface AppThread {
  threadId: string;
  name: string | null;
  preview: string;
  cwd: string | null;
  modelProvider: string | null;
  status: ThreadStatusKind;
  updatedAt: number;
}

export interface AppThreadTurnItem {
  id: string | null;
  type: string;
  phase: string | null;
  text: string | null;
}

export interface AppThreadTurn {
  id: string;
  status: string | null;
  error: string | null;
  items: AppThreadTurnItem[];
}

export interface AppThreadWithTurns extends AppThread {
  turns: AppThreadTurn[];
}

export interface ThreadSessionState {
  thread: AppThread;
  model: string;
  modelProvider: string;
  reasoningEffort: ReasoningEffortValue | null;
  serviceTier: ServiceTierValue | null;
  cwd: string;
}

export interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: ReasoningEffortValue[];
  defaultReasoningEffort: ReasoningEffortValue;
}

export type ApprovalKind = 'command' | 'fileChange';

export interface PendingUserInputOption {
  label: string;
  description: string;
}

export interface PendingUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: PendingUserInputOption[] | null;
}

export interface PendingApprovalRecord {
  localId: string;
  serverRequestId: string;
  kind: ApprovalKind;
  chatId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId: string | null;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  summary: string | null;
  riskLevel: ApprovalRiskLevel | null;
  details: Record<string, unknown> | null;
  messageId: number | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface PendingUserInputRecord {
  localId: string;
  serverRequestId: string;
  chatId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  messageId: number | null;
  questions: PendingUserInputQuestion[];
  answers: Record<string, string[]>;
  currentQuestionIndex: number;
  awaitingFreeText: boolean;
  createdAt: number;
  resolvedAt: number | null;
}

export interface PendingUserInputMessageRecord {
  inputLocalId: string;
  questionIndex: number;
  messageId: number;
  messageKind: PendingUserInputMessageKind;
  createdAt: number;
}

export interface PendingAttachmentBatchAttachment {
  kind: string;
  fileId: string;
  fileUniqueId: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  isAnimated: boolean;
  isVideo: boolean;
  localPath: string;
  relativePath: string;
  nativeImage: boolean;
}

export interface PendingAttachmentBatchRecord {
  batchId: string;
  scopeId: string;
  chatId: string;
  threadId: string;
  mediaGroupId: string | null;
  noteText: string;
  attachments: PendingAttachmentBatchAttachment[];
  receiptMessageId: number | null;
  status: PendingAttachmentBatchStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface GuidedPlanSession {
  sessionId: string;
  chatId: string;
  threadId: string;
  sourceTurnId: string | null;
  executionTurnId: string | null;
  state: GuidedPlanSessionState;
  confirmationRequired: boolean;
  confirmedPlanVersion: number | null;
  latestPlanVersion: number | null;
  currentPromptId: string | null;
  currentApprovalId: string | null;
  queueDepth: number;
  lastPlanMessageId: number | null;
  lastPromptMessageId: number | null;
  lastApprovalMessageId: number | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface PlanSnapshotStep {
  step: string;
  status: string;
}

export interface PlanSnapshotRecord {
  sessionId: string;
  version: number;
  sourceEvent: string;
  explanation: string | null;
  steps: PlanSnapshotStep[];
  createdAt: number;
}

export interface QueuedTurnInputRecord {
  queueId: string;
  scopeId: string;
  chatId: string;
  threadId: string;
  input: unknown[];
  sourceSummary: string;
  telegramMessageId: number | null;
  status: QueuedTurnInputStatus;
  createdAt: number;
  updatedAt: number;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface AccountRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  planType: string | null;
}

export interface AccountIdentitySnapshot {
  email: string | null;
  name: string | null;
  authMode: string | null;
  accountId: string | null;
}

export interface RuntimeStatus {
  engine: 'codex' | 'gemini';
  instanceId: string | null;
  running: boolean;
  connected: boolean;
  userAgent: string | null;
  botUsername: string | null;
  currentBindings: number;
  pendingApprovals: number;
  pendingUserInputs: number;
  pendingAttachmentBatches: number;
  queuedTurns: number;
  activeTurns: number;
  accountRateLimits: AccountRateLimitSnapshot | null;
  lastError: string | null;
  updatedAt: string;
}
