/** Session row: `chatId` holds the bridge scope id (e.g. `telegram:…`). */
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
export type ThreadStatusKind = 'active' | 'idle' | 'notLoaded' | 'systemError';

export interface ChatSessionSettings {
  /** Bridge scope id (e.g. `telegram:…`). */
  chatId: string;
  model: string | null;
  reasoningEffort: ReasoningEffortValue | null;
  locale: AppLocale | null;
  accessPreset: AccessPresetValue | null;
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
  source: string | null;
  path: string | null;
  status: ThreadStatusKind;
  updatedAt: number;
}

export interface AppTurnItemSnapshot {
  itemId: string;
  type: string;
  phase: string | null;
  text: string | null;
  command: string | null;
  status: string | null;
  aggregatedOutput: string | null;
}

export interface AppTurnSnapshot {
  turnId: string;
  status: string;
  error: string | null;
  items: AppTurnItemSnapshot[];
}

export interface AppThreadSnapshot extends AppThread {
  activeFlags: string[];
  turns: AppTurnSnapshot[];
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

export interface PendingApprovalRecord {
  localId: string;
  serverRequestId: string;
  kind: ApprovalKind;
  /** Bridge scope id (e.g. `telegram:…`). */
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

export interface RuntimeStatus {
  running: boolean;
  connected: boolean;
  userAgent: string | null;
  botUsername: string | null;
  currentBindings: number;
  pendingApprovals: number;
  activeTurns: number;
  lastError: string | null;
  updatedAt: string;
  /** Which messaging transports are expected active in this process. */
  channels?: { telegram: boolean; weixin: boolean };
}
