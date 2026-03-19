import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import { GeminiCliClient, type GeminiCliRunHandle } from '../gemini_cli/client.js';
import { mapGeminiToolToParsedCmdType, parseGeminiStreamLine, type GeminiStreamEvent } from '../gemini_cli/events.js';
import type { Logger } from '../logger.js';
import { spawnCommandSync } from '../process/spawn_command.js';
import type {
  AccountRateLimitSnapshot,
  AppThread,
  AppThreadTurn,
  AppThreadWithTurns,
  ModelInfo,
  ThreadSessionState,
} from '../types.js';
import { unsupportedProviderFeature } from './provider_errors.js';
import type {
  EngineNotification,
  EngineProvider,
  EngineServerRequest,
  ListThreadsOptions,
  ResumeThreadOptions,
  StartThreadOptions,
  StartTurnOptions,
  SteerTurnOptions,
  TurnStartResult,
  TurnSteerResult,
  TurnInput,
} from './types.js';

interface GeminiSessionRecord {
  localThreadId: string;
  canonicalThreadId: string;
  actualSessionId: string | null;
  name: string | null;
  preview: string;
  cwd: string | null;
  model: string | null;
  updatedAt: number;
}

interface GeminiActiveTurn {
  turnId: string;
  threadId: string;
  itemId: string;
  reasoningItemId: string;
  cwd: string;
  model: string | null;
  prompt: string;
  process: GeminiCliRunHandle;
  assistantStarted: boolean;
  reasoningCompleted: boolean;
  finalText: string;
  completed: boolean;
  interrupted: boolean;
  timeoutTriggered: boolean;
  stderr: string[];
  pendingError: string | null;
}

const DEFAULT_GEMINI_MODEL_CATALOG = [
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
] as const;

export class GeminiEngineProvider extends EventEmitter implements EngineProvider {
  readonly engine = 'gemini' as const;
  readonly capabilities = {
    threads: false,
    reveal: false,
    guidedPlan: 'none',
    approvals: 'none',
    steerActiveTurn: false,
    rateLimits: false,
    reasoningEffort: false,
    serviceTier: false,
    reconnect: false,
  } as const;
  private readonly client: GeminiCliClient;
  private readonly sessions = new Map<string, GeminiSessionRecord>();
  private readonly activeTurns = new Map<string, GeminiActiveTurn>();
  private readonly threadAliases = new Map<string, string>();
  private userAgent: string | null = null;

  constructor(
    private readonly config: Pick<AppConfig, 'geminiCliBin' | 'geminiDefaultModel' | 'geminiModelAllowlist' | 'geminiIncludeDirectories' | 'geminiHeadlessTimeoutMs' | 'defaultCwd'>,
    private readonly logger: Logger,
  ) {
    super();
    this.client = new GeminiCliClient(config.geminiCliBin, logger);
    this.client.on('connected', () => {
      if (!this.userAgent) {
        this.userAgent = detectGeminiUserAgent(config.geminiCliBin);
      }
      this.emit('connected');
    });
    this.client.on('disconnected', () => {
      this.emit('disconnected');
    });
  }

  on(event: 'notification', listener: (message: EngineNotification) => void): this;
  on(event: 'serverRequest', listener: (message: EngineServerRequest) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  start(): Promise<void> {
    return this.client.start();
  }

  stop(): Promise<void> {
    this.activeTurns.clear();
    return this.client.stop();
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  getUserAgent(): string | null {
    return this.userAgent ?? 'gemini-cli';
  }

  listThreads(options: ListThreadsOptions): Promise<AppThread[]> {
    const searchTerm = options.searchTerm?.trim().toLowerCase() ?? null;
    const threads = [...new Map(
      [...this.sessions.values()].map((session) => [session.canonicalThreadId, session]),
    ).values()]
      .filter((session) => {
        if (!searchTerm) {
          return true;
        }
        return session.canonicalThreadId.toLowerCase().includes(searchTerm)
          || (session.name?.toLowerCase().includes(searchTerm) ?? false)
          || session.preview.toLowerCase().includes(searchTerm);
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, options.limit)
      .map((session) => this.toAppThread(session));
    return Promise.resolve(threads);
  }

  readThread(threadId: string): Promise<AppThread | null> {
    return Promise.resolve(this.toAppThreadOrNull(threadId));
  }

  readThreadWithTurns(threadId: string): Promise<AppThreadWithTurns | null> {
    const thread = this.toAppThreadOrNull(threadId);
    if (!thread) {
      return Promise.resolve(null);
    }
    const turns: AppThreadTurn[] = [];
    if (thread.preview.trim()) {
      turns.push({
        id: `${thread.threadId}:preview`,
        status: 'completed',
        error: null,
        items: [{
          id: `${thread.threadId}:preview:item`,
          type: 'assistant_message',
          phase: 'final',
          text: thread.preview,
        }],
      });
    }
    return Promise.resolve({ ...thread, turns });
  }

  renameThread(threadId: string, name: string): Promise<void> {
    const session = this.getOrCreateSession(threadId);
    session.name = name.trim() || null;
    session.updatedAt = Date.now();
    this.registerSession(session);
    return Promise.resolve();
  }

  async startThread(options: StartThreadOptions): Promise<ThreadSessionState> {
    const session = this.createLocalSession({
      cwd: options.cwd ?? this.config.defaultCwd,
      model: options.model ?? this.config.geminiDefaultModel ?? null,
    });
    return this.toThreadSessionState(session);
  }

  async resumeThread(options: ResumeThreadOptions): Promise<ThreadSessionState> {
    const session = this.getOrCreateSession(options.threadId);
    return this.toThreadSessionState(session);
  }

  async revealThread(_threadId: string): Promise<void> {
    throw unsupportedProviderFeature('gemini', 'revealThread', 'Reveal is not supported by Gemini CLI instances');
  }

  async startTurn(options: StartTurnOptions): Promise<TurnStartResult> {
    const turnId = `gemini-turn-${crypto.randomBytes(8).toString('hex')}`;
    const itemId = `gemini-item-${crypto.randomBytes(6).toString('hex')}`;
    const reasoningItemId = `gemini-reason-${crypto.randomBytes(6).toString('hex')}`;
    const session = this.getOrCreateSession(options.threadId, {
      cwd: options.cwd ?? this.config.defaultCwd,
      model: options.model ?? this.config.geminiDefaultModel ?? null,
    });
    const cwd = options.cwd ?? session.cwd ?? this.config.defaultCwd;
    const model = options.model ?? session.model ?? this.config.geminiDefaultModel ?? null;
    const prompt = buildGeminiPrompt(options.input, options.developerInstructions);
    const resumeSessionId = session.actualSessionId ?? null;

    this.emitNotification({
      method: 'item/started',
      params: {
        turnId,
        item: {
          id: reasoningItemId,
          type: 'reasoning',
        },
      },
    });

    const handle = this.client.run({
      prompt,
      cwd,
      model,
      resumeSessionId,
      includeDirectories: this.config.geminiIncludeDirectories,
      approvalMode: resolveGeminiApprovalMode(options.geminiApprovalMode, options.collaborationMode),
      timeoutMs: this.config.geminiHeadlessTimeoutMs,
    }, {
      onStdoutLine: (line) => {
        this.handleStdoutLine(turnId, line);
      },
      onStderrLine: (line) => {
        this.handleStderrLine(turnId, line);
      },
      onTimeout: () => {
        const active = this.activeTurns.get(turnId);
        if (active) {
          active.timeoutTriggered = true;
          active.pendingError = 'Gemini CLI headless turn timed out';
        }
      },
      onError: (error) => {
        const active = this.activeTurns.get(turnId);
        if (active) {
          active.pendingError = error instanceof Error ? error.message : String(error);
        }
      },
      onExit: (code, signal) => {
        this.handleTurnExit(turnId, code, signal);
      },
    });

    this.activeTurns.set(turnId, {
      turnId,
      threadId: session.canonicalThreadId,
      itemId,
      reasoningItemId,
      cwd,
      model,
      prompt,
      process: handle,
      assistantStarted: false,
      reasoningCompleted: false,
      finalText: '',
      completed: false,
      interrupted: false,
      timeoutTriggered: false,
      stderr: [],
      pendingError: null,
    });

    return { id: turnId, status: 'in_progress' };
  }

  async steerTurn(_options: SteerTurnOptions): Promise<TurnSteerResult> {
    throw unsupportedProviderFeature('gemini', 'steerTurn', 'Active-turn steering is not supported by Gemini CLI instances');
  }

  async interruptTurn(_threadId: string, turnId: string): Promise<void> {
    const active = this.activeTurns.get(turnId);
    if (!active) {
      return;
    }
    active.interrupted = true;
    active.process.cancel('SIGTERM');
  }

  async respond(_requestId: string | number, _result: unknown): Promise<void> {
    throw unsupportedProviderFeature('gemini', 'respond', 'Gemini CLI provider does not support interactive server requests');
  }

  async respondError(_requestId: string | number, _message: string): Promise<void> {
    throw unsupportedProviderFeature('gemini', 'respondError', 'Gemini CLI provider does not support interactive server requests');
  }

  async listModels(): Promise<ModelInfo[]> {
    const configured = [
      ...(this.config.geminiDefaultModel ? [this.config.geminiDefaultModel] : []),
      ...this.config.geminiModelAllowlist,
    ]
      .map((entry) => entry.trim())
      .filter(Boolean);
    const unique = [...new Set(configured.length > 0 ? configured : DEFAULT_GEMINI_MODEL_CATALOG)];
    const models = unique.map((model, index) => ({
      id: model,
      model,
      displayName: model,
      description: 'Configured Gemini CLI model',
      isDefault: index === 0,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: 'none' as const,
    }));
    return Promise.resolve(models);
  }

  private handleStdoutLine(turnId: string, line: string): void {
    const active = this.activeTurns.get(turnId);
    if (!active || active.completed) {
      return;
    }
    const event = parseGeminiStreamLine(line);
    if (!event) {
      if (line.trim()) {
        this.logger.debug('gemini.stdout.ignored', { line: line.trim() });
      }
      return;
    }
    this.handleGeminiEvent(active, event);
  }

  private handleStderrLine(turnId: string, line: string): void {
    const active = this.activeTurns.get(turnId);
    if (!active || active.completed) {
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    active.stderr.push(trimmed);
    if (active.stderr.length > 20) {
      active.stderr.shift();
    }
    this.logger.debug('gemini.stderr', { turnId, line: trimmed });
  }

  private handleGeminiEvent(active: GeminiActiveTurn, event: GeminiStreamEvent): void {
    switch (event.type) {
      case 'init': {
        const sessionId = typeof event.session_id === 'string' && event.session_id.trim()
          ? event.session_id.trim()
          : null;
        if (sessionId) {
          this.bindActualSessionId(active.threadId, sessionId, active.cwd, event.model ?? active.model);
          this.emitNotification({
            method: 'sessionConfigured',
            params: {
              session_id: sessionId,
              cwd: active.cwd,
              model: event.model ?? active.model,
              reasoning_effort: null,
              service_tier: null,
            },
          });
        }
        return;
      }
      case 'message': {
        if (event.role !== 'assistant' || typeof event.content !== 'string' || !event.content) {
          return;
        }
        this.completeReasoningIfNeeded(active);
        this.startAssistantIfNeeded(active);
        active.finalText += event.content;
        this.emitNotification({
          method: 'item/agentMessage/delta',
          params: {
            turnId: active.turnId,
            itemId: active.itemId,
            phase: 'final',
            delta: event.content,
          },
        });
        return;
      }
      case 'tool_use': {
        const toolId = typeof event.tool_id === 'string' && event.tool_id ? event.tool_id : `gemini-tool-${crypto.randomBytes(4).toString('hex')}`;
        this.emitToolNotification('codex/event/exec_command_begin', active, toolId, event.tool_name ?? 'tool', event.parameters ?? {});
        return;
      }
      case 'tool_result': {
        const toolId = typeof event.tool_id === 'string' && event.tool_id ? event.tool_id : `gemini-tool-${crypto.randomBytes(4).toString('hex')}`;
        this.emitToolNotification('codex/event/exec_command_end', active, toolId, 'tool', { status: event.status ?? null, output: event.output ?? null });
        return;
      }
      case 'error': {
        active.pendingError = event.message?.trim() || 'Gemini CLI returned an error event';
        return;
      }
      case 'result': {
        this.completeReasoningIfNeeded(active);
        this.completeAssistantIfNeeded(active);
        const errorText = active.pendingError ?? extractGeminiErrorText(event.error);
        this.completeTurn(active, event.status === 'success' ? 'success' : 'error', errorText);
        return;
      }
    }
  }

  private handleTurnExit(turnId: string, code: number | null, signal: NodeJS.Signals | null): void {
    const active = this.activeTurns.get(turnId);
    if (!active || active.completed) {
      return;
    }
    this.completeReasoningIfNeeded(active);
    this.completeAssistantIfNeeded(active);
    if (active.interrupted) {
      this.completeTurn(active, 'interrupted', active.pendingError ?? 'Interrupted');
      return;
    }
    if (active.timeoutTriggered) {
      this.completeTurn(active, 'error', active.pendingError ?? 'Gemini CLI headless turn timed out');
      return;
    }
    if (code === 0 && !active.pendingError) {
      this.completeTurn(active, 'success', null);
      return;
    }
    const stderrText = active.stderr.join('\n').trim();
    const errorText = active.pendingError ?? (stderrText || `Gemini CLI exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`);
    this.completeTurn(active, 'error', errorText);
  }

  private completeReasoningIfNeeded(active: GeminiActiveTurn): void {
    if (active.reasoningCompleted) {
      return;
    }
    active.reasoningCompleted = true;
    this.emitNotification({
      method: 'item/completed',
      params: {
        turnId: active.turnId,
        item: {
          id: active.reasoningItemId,
          type: 'reasoning',
        },
      },
    });
  }

  private startAssistantIfNeeded(active: GeminiActiveTurn): void {
    if (active.assistantStarted) {
      return;
    }
    active.assistantStarted = true;
    this.emitNotification({
      method: 'item/started',
      params: {
        turnId: active.turnId,
        item: {
          id: active.itemId,
          type: 'agentMessage',
          phase: 'final',
        },
      },
    });
  }

  private completeAssistantIfNeeded(active: GeminiActiveTurn): void {
    if (!active.assistantStarted) {
      if (!active.finalText.trim()) {
        return;
      }
      this.startAssistantIfNeeded(active);
    }
    this.emitNotification({
      method: 'item/completed',
      params: {
        turnId: active.turnId,
        item: {
          id: active.itemId,
          type: 'agentMessage',
          phase: 'final',
          text: active.finalText,
        },
      },
    });
    const session = this.getOrCreateSession(active.threadId, { cwd: active.cwd, model: active.model });
    session.preview = active.finalText.trim() || session.preview;
    session.updatedAt = Date.now();
    this.registerSession(session);
  }

  private completeTurn(active: GeminiActiveTurn, status: 'success' | 'error' | 'interrupted', errorText: string | null): void {
    if (active.completed) {
      return;
    }
    active.completed = true;
    if (status !== 'success') {
      this.logger.warn('gemini.turn_failed', {
        turnId: active.turnId,
        threadId: active.threadId,
        status,
        error: errorText,
        stderr: active.stderr.slice(-5),
      });
    }
    this.emitNotification({
      method: 'turn/completed',
      params: {
        turnId: active.turnId,
        status,
        error: errorText,
        result: {
          status,
          error: errorText,
        },
      },
    });
    this.activeTurns.delete(active.turnId);
  }

  private emitToolNotification(method: 'codex/event/exec_command_begin' | 'codex/event/exec_command_end', active: GeminiActiveTurn, toolId: string, toolName: string, parameters: Record<string, unknown>): void {
    const parsedType = mapGeminiToolToParsedCmdType(toolName);
    this.emitNotification({
      method,
      params: {
        msg: {
          call_id: toolId,
          turn_id: active.turnId,
          command: [toolName],
          cwd: active.cwd,
          parsed_cmd: parsedType ? [{ type: parsedType, ...parameters }] : [],
        },
      },
    });
  }

  private emitNotification(notification: EngineNotification): void {
    this.emit('notification', notification);
  }

  private createLocalSession(input: { cwd: string; model: string | null }): GeminiSessionRecord {
    const localThreadId = `gemini-local-${crypto.randomBytes(8).toString('hex')}`;
    const session: GeminiSessionRecord = {
      localThreadId,
      canonicalThreadId: localThreadId,
      actualSessionId: null,
      name: null,
      preview: '',
      cwd: input.cwd,
      model: input.model,
      updatedAt: Date.now(),
    };
    this.registerSession(session);
    return session;
  }

  private bindActualSessionId(threadId: string, sessionId: string, cwd: string, model: string | null | undefined): GeminiSessionRecord {
    const current = this.getOrCreateSession(threadId, { cwd, model: model ?? null });
    current.actualSessionId = sessionId;
    current.canonicalThreadId = sessionId;
    current.cwd = cwd;
    current.model = model ?? current.model;
    current.updatedAt = Date.now();
    this.threadAliases.set(threadId, sessionId);
    this.registerSession(current);
    return current;
  }

  private getOrCreateSession(threadId: string, seed?: { cwd: string | null; model: string | null }): GeminiSessionRecord {
    const resolvedId = this.threadAliases.get(threadId) ?? threadId;
    const existing = this.sessions.get(resolvedId) ?? this.sessions.get(threadId);
    if (existing) {
      if (threadId !== existing.canonicalThreadId) {
        this.threadAliases.set(threadId, existing.canonicalThreadId);
      }
      if (seed?.cwd) {
        existing.cwd = seed.cwd;
      }
      if (seed?.model) {
        existing.model = seed.model;
      }
      return existing;
    }
    const session: GeminiSessionRecord = {
      localThreadId: threadId,
      canonicalThreadId: resolvedId,
      actualSessionId: resolvedId.startsWith('gemini-local-') ? null : resolvedId,
      name: null,
      preview: '',
      cwd: seed?.cwd ?? this.config.defaultCwd,
      model: seed?.model ?? this.config.geminiDefaultModel ?? null,
      updatedAt: Date.now(),
    };
    this.registerSession(session);
    return session;
  }

  private registerSession(session: GeminiSessionRecord): void {
    this.sessions.set(session.canonicalThreadId, session);
    this.sessions.set(session.localThreadId, session);
    if (session.actualSessionId) {
      this.sessions.set(session.actualSessionId, session);
      this.threadAliases.set(session.localThreadId, session.actualSessionId);
      this.threadAliases.set(session.canonicalThreadId, session.actualSessionId);
    }
  }

  private toAppThreadOrNull(threadId: string): AppThread | null {
    const session = this.sessions.get(this.threadAliases.get(threadId) ?? threadId)
      ?? this.sessions.get(threadId)
      ?? (threadId.trim() ? this.getOrCreateSession(threadId) : null);
    return session ? this.toAppThread(session) : null;
  }

  private toAppThread(session: GeminiSessionRecord): AppThread {
    return {
      threadId: session.canonicalThreadId,
      name: session.name,
      preview: session.preview,
      cwd: session.cwd,
      modelProvider: 'gemini-cli',
      status: 'idle',
      updatedAt: session.updatedAt,
    };
  }

  private toThreadSessionState(session: GeminiSessionRecord): ThreadSessionState {
    return {
      thread: this.toAppThread(session),
      model: session.model ?? this.config.geminiDefaultModel ?? '',
      modelProvider: 'gemini-cli',
      reasoningEffort: null,
      serviceTier: null,
      cwd: session.cwd ?? this.config.defaultCwd,
    };
  }
}

function resolveGeminiApprovalMode(
  geminiApprovalMode: StartTurnOptions['geminiApprovalMode'],
  collaborationMode: StartTurnOptions['collaborationMode'],
): 'default' | 'auto_edit' | 'yolo' | 'plan' {
  if (geminiApprovalMode === 'auto_edit' || geminiApprovalMode === 'yolo' || geminiApprovalMode === 'plan') {
    return geminiApprovalMode;
  }
  if (collaborationMode === 'plan') {
    return 'plan';
  }
  return 'default';
}

function extractGeminiErrorText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const key of ['message', 'error', 'reason', 'status']) {
    if (key in value) {
      const nested = extractGeminiErrorText((value as Record<string, unknown>)[key]);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function buildGeminiPrompt(input: TurnInput[], developerInstructions: string | null): string {
  const sections: string[] = [];
  if (developerInstructions?.trim()) {
    sections.push(`Developer instructions:\n${developerInstructions.trim()}`);
  }
  const textParts = input
    .filter((entry): entry is Extract<TurnInput, { type: 'text' }> => entry.type === 'text')
    .map((entry) => entry.text.trim())
    .filter(Boolean);
  if (textParts.length > 0) {
    sections.push(textParts.join('\n\n'));
  }
  const localImages = input
    .filter((entry): entry is Extract<TurnInput, { type: 'localImage' }> => entry.type === 'localImage')
    .map((entry) => entry.path.trim())
    .filter(Boolean);
  if (localImages.length > 0) {
    sections.push([
      'Local image paths available in the workspace:',
      ...localImages.map((imagePath) => `- ${imagePath}`),
    ].join('\n'));
  }
  return sections.join('\n\n').trim();
}

function detectGeminiUserAgent(geminiCliBin: string): string {
  try {
    const result = spawnCommandSync(geminiCliBin, ['--version'], { encoding: 'utf8' });
    const version = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status === 0 && version) {
      return `gemini-cli/${version}`;
    }
  } catch {
    // ignore version lookup failures
  }
  return 'gemini-cli';
}

export function createGeminiEngineProvider(
  config: Pick<AppConfig, 'geminiCliBin' | 'geminiDefaultModel' | 'geminiModelAllowlist' | 'geminiIncludeDirectories' | 'geminiHeadlessTimeoutMs' | 'defaultCwd'>,
  logger: Logger,
): GeminiEngineProvider {
  return new GeminiEngineProvider(config, logger);
}
