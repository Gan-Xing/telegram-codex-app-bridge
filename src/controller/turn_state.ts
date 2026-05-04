import type { PendingApprovalRecord, PlanSnapshotStep } from '../types.js';
import type { TelegramRenderRoute } from '../telegram/rendering.js';
import type { TurnOutputKind } from './activity.js';
import type { TurnCompletionState } from './turn_completion.js';

export interface RenderedTelegramMessage {
  messageId: number;
  text: string;
}

export interface ActiveTurnSegment {
  itemId: string;
  phase: string | null;
  outputKind: TurnOutputKind;
  rawText: string;
  text: string;
  completed: boolean;
  messages: RenderedTelegramMessage[];
}

export interface ToolBatchCounts {
  files: number;
  searches: number;
  edits: number;
  commands: number;
}

export interface ToolBatchState {
  openCallIds: Set<string>;
  actionKeys: Set<string>;
  actionLines: string[];
  counts: ToolBatchCounts;
  finalizeTimer: NodeJS.Timeout | null;
}

export interface ArchivedStatusContent {
  text: string;
  html: string | null;
}

export interface ActiveTurn {
  turnKind?: 'default' | 'review';
  scopeId: string;
  profileId?: string | null;
  chatId: string;
  topicId: number | null;
  renderRoute: TelegramRenderRoute;
  threadId: string;
  turnId: string;
  queuedInputId: string | null;
  previewMessageId: number;
  previewActive: boolean;
  draftId: number | null;
  draftText: string | null;
  buffer: string;
  finalText: string | null;
  completionState: TurnCompletionState;
  completionStatusText: string | null;
  completionErrorText: string | null;
  interruptRequested: boolean;
  statusMessageText: string | null;
  statusNeedsRebase: boolean;
  segments: ActiveTurnSegment[];
  reasoningActiveCount: number;
  pendingApprovalKinds: Set<PendingApprovalRecord['kind']>;
  pendingUserInputId: string | null;
  toolBatch: ToolBatchState | null;
  pendingArchivedStatus: ArchivedStatusContent | null;
  planMessageId: number | null;
  planText: string | null;
  planExplanation: string | null;
  planSteps: PlanSnapshotStep[];
  planDraftText: string | null;
  planLastRenderedAt: number;
  planRenderRequested: boolean;
  forcePlanRender: boolean;
  planRenderTask: Promise<void> | null;
  guidedPlanSessionId: string | null;
  guidedPlanDraftOnly: boolean;
  guidedPlanExecutionBlocked: boolean;
  renderRetryTimer: NodeJS.Timeout | null;
  lastStreamFlushAt: number;
  renderRequested: boolean;
  forceStatusFlush: boolean;
  forceStreamFlush: boolean;
  preferStatusBeforeStream: boolean;
  renderTask: Promise<void> | null;
  resolver: () => void;
}
