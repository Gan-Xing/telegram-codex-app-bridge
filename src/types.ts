export interface ThreadBinding {
  chatId: string;
  threadId: string;
  cwd: string | null;
  updatedAt: number;
}

export type AppLocale = 'en' | 'zh';
export type ApprovalPolicyValue = 'on-request' | 'on-failure' | 'never' | 'untrusted';
export type SandboxModeValue = 'read-only' | 'workspace-write' | 'danger-full-access';
export type AccessPresetValue = 'read-only' | 'default' | 'full-access';
export type ReasoningEffortValue = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type CollaborationModeValue = 'default' | 'plan';
export type ThreadStatusKind = 'active' | 'idle' | 'notLoaded' | 'systemError';

export interface ChatSessionSettings {
  chatId: string;
  model: string | null;
  reasoningEffort: ReasoningEffortValue | null;
  locale: AppLocale | null;
  accessPreset: AccessPresetValue | null;
  collaborationMode: CollaborationModeValue | null;
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

export interface ThreadSessionState {
  thread: AppThread;
  model: string;
  modelProvider: string;
  reasoningEffort: ReasoningEffortValue | null;
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

export interface RuntimeStatus {
  running: boolean;
  connected: boolean;
  userAgent: string | null;
  botUsername: string | null;
  currentBindings: number;
  pendingApprovals: number;
  pendingUserInputs: number;
  activeTurns: number;
  lastError: string | null;
  updatedAt: string;
}
