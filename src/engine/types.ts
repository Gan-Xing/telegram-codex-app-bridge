import type {
  AccountIdentitySnapshot,
  AccountRateLimitSnapshot,
  AppThread,
  AppThreadWithTurns,
  CollaborationModeValue,
  GeminiApprovalModeValue,
  ModelInfo,
  ReasoningEffortValue,
  SandboxModeValue,
  ServiceTierValue,
  ThreadSessionState,
} from '../types.js';

export interface EngineNotification {
  method: string;
  params?: any;
}

export interface EngineServerRequest {
  id: string | number;
  method: string;
  params?: any;
}

export interface ListThreadsOptions {
  limit: number;
  searchTerm?: string | null;
}

export interface StartThreadOptions {
  cwd: string | null;
  approvalPolicy: string;
  sandboxMode: SandboxModeValue;
  model: string | null;
  serviceTier: ServiceTierValue | null;
}

export interface ResumeThreadOptions {
  threadId: string;
}

export interface TextTurnInput {
  type: 'text';
  text: string;
  text_elements: [];
}

export interface LocalImageTurnInput {
  type: 'localImage';
  path: string;
}

export type TurnInput = TextTurnInput | LocalImageTurnInput;

export interface StartTurnOptions {
  threadId: string;
  input: TurnInput[];
  approvalPolicy: string;
  sandboxMode: SandboxModeValue;
  cwd: string | null;
  model: string | null;
  serviceTier: ServiceTierValue | null;
  effort: ReasoningEffortValue | null;
  collaborationMode: CollaborationModeValue | null;
  geminiApprovalMode?: GeminiApprovalModeValue | null;
  developerInstructions: string | null;
}

export interface SteerTurnOptions {
  threadId: string;
  turnId: string;
  input: TurnInput[];
}

export interface TurnStartResult {
  id: string;
  status: string;
}

export interface TurnSteerResult {
  turnId: string;
}

export interface EngineCapabilities {
  threads: boolean;
  reveal: boolean;
  guidedPlan: 'full' | 'basic' | 'none';
  approvals: 'full' | 'limited' | 'none';
  steerActiveTurn: boolean;
  rateLimits: boolean;
  reasoningEffort: boolean;
  serviceTier: boolean;
  reconnect: boolean;
}

export const DEFAULT_ENGINE_CAPABILITIES: EngineCapabilities = {
  threads: true,
  reveal: true,
  guidedPlan: 'full',
  approvals: 'full',
  steerActiveTurn: true,
  rateLimits: true,
  reasoningEffort: true,
  serviceTier: true,
  reconnect: true,
};

export function resolveEngineCapabilities(
  capabilities?: Partial<EngineCapabilities> | null,
): EngineCapabilities {
  return {
    ...DEFAULT_ENGINE_CAPABILITIES,
    ...(capabilities ?? {}),
  };
}

export interface EngineProvider {
  readonly engine: 'codex' | 'gemini';
  readonly capabilities: EngineCapabilities;

  on(event: 'notification', listener: (message: EngineNotification) => void): this;
  on(event: 'serverRequest', listener: (message: EngineServerRequest) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;

  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  getUserAgent(): string | null;
  getAccountIdentity?(): AccountIdentitySnapshot | null;
  readAccountIdentity?(): Promise<AccountIdentitySnapshot | null>;
  getAccountRateLimits?(): AccountRateLimitSnapshot | null;
  readAccountRateLimits?(): Promise<AccountRateLimitSnapshot | null>;

  listThreads(options: ListThreadsOptions): Promise<AppThread[]>;
  readThread(threadId: string, includeTurns?: boolean): Promise<AppThread | null>;
  readThreadWithTurns(threadId: string): Promise<AppThreadWithTurns | null>;
  renameThread(threadId: string, name: string): Promise<void>;

  startThread(options: StartThreadOptions): Promise<ThreadSessionState>;
  resumeThread(options: ResumeThreadOptions): Promise<ThreadSessionState>;
  revealThread(threadId: string): Promise<void>;

  startTurn(options: StartTurnOptions): Promise<TurnStartResult>;
  steerTurn(options: SteerTurnOptions): Promise<TurnSteerResult>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  respond(requestId: string | number, result: unknown): Promise<void>;
  respondError(requestId: string | number, message: string): Promise<void>;

  listModels(): Promise<ModelInfo[]>;
}
