import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import { ClaudeCliClient, type ClaudeCliRunHandle } from '../claude_cli/client.js';
import { mapClaudeToolToParsedCmdType, parseClaudeStreamLine, type ClaudeStreamEvent } from '../claude_cli/events.js';
import { spawnCommandSync } from '../process/spawn_command.js';
import type { Logger } from '../logger.js';
import type {
  AccountIdentitySnapshot,
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
  TurnInput,
  TurnStartResult,
  TurnSteerResult,
} from './types.js';

interface ClaudeSessionRecord {
  localThreadId: string;
  canonicalThreadId: string;
  actualSessionId: string | null;
  name: string | null;
  preview: string;
  cwd: string | null;
  model: string | null;
  updatedAt: number;
}

interface ClaudeToolRecord {
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeActiveTurn {
  turnId: string;
  threadId: string;
  itemId: string;
  reasoningItemId: string;
  cwd: string;
  model: string | null;
  prompt: string;
  process: ClaudeCliRunHandle;
  assistantStarted: boolean;
  reasoningCompleted: boolean;
  finalText: string;
  latestAssistantText: string;
  sawStreamText: boolean;
  completed: boolean;
  interrupted: boolean;
  timeoutTriggered: boolean;
  stderr: string[];
  pendingError: string | null;
  pendingDeltas: string[];
  streamTimer: NodeJS.Timeout | null;
  toolUses: Map<string, ClaudeToolRecord>;
}

const DEFAULT_CLAUDE_MODEL_CATALOG = [
  'sonnet',
  'opus',
  'haiku',
] as const;

const CLAUDE_STREAM_CHUNK_SIZE = 160;
const CLAUDE_STREAM_INTERVAL_MS = 120;

export class ClaudeEngineProvider extends EventEmitter implements EngineProvider {
  readonly engine = 'claude' as const;
  readonly capabilities = {
    threads: true,
    reveal: false,
    guidedPlan: 'none',
    approvals: 'limited',
    steerActiveTurn: false,
    rateLimits: false,
    reasoningEffort: false,
    serviceTier: false,
    reconnect: false,
  } as const;

  private readonly client: ClaudeCliClient;
  private readonly sessions = new Map<string, ClaudeSessionRecord>();
  private readonly activeTurns = new Map<string, ClaudeActiveTurn>();
  private readonly threadAliases = new Map<string, string>();
  private userAgent: string | null = null;
  private accountIdentity: AccountIdentitySnapshot | null = null;

  constructor(
    private readonly config: Pick<AppConfig, 'claudeCliBin' | 'claudeDefaultModel' | 'claudeModelAllowlist' | 'claudeIncludeDirectories' | 'claudeAllowedTools' | 'claudePermissionMode' | 'claudeHeadlessTimeoutMs' | 'defaultCwd'>,
    private readonly logger: Logger,
  ) {
    super();
    this.client = new ClaudeCliClient(config.claudeCliBin ?? 'claude', logger);
    this.client.on('connected', () => {
      if (!this.userAgent) {
        this.userAgent = detectClaudeUserAgent(this.config.claudeCliBin ?? 'claude');
      }
      void this.readAccountIdentity().catch((error) => {
        this.logger.debug('claude.account_identity_refresh_failed', { error: String(error) });
      });
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
    return this.userAgent ?? 'claude-code';
  }

  getAccountIdentity(): AccountIdentitySnapshot | null {
    return this.accountIdentity;
  }

  async readAccountIdentity(): Promise<AccountIdentitySnapshot | null> {
    const identity = readClaudeAccountIdentity(this.config.claudeCliBin ?? 'claude');
    this.accountIdentity = identity;
    return identity;
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

  readThread(threadId: string, _includeTurns = false, _scopeId?: string | null): Promise<AppThread | null> {
    return Promise.resolve(this.toAppThreadOrNull(threadId));
  }

  readThreadWithTurns(threadId: string, _scopeId?: string | null): Promise<AppThreadWithTurns | null> {
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

  renameThread(threadId: string, name: string, _scopeId?: string | null): Promise<void> {
    const session = this.getOrCreateSession(threadId);
    session.name = name.trim() || null;
    session.updatedAt = Date.now();
    this.registerSession(session);
    return Promise.resolve();
  }

  async archiveThread(_threadId: string, _scopeId?: string | null): Promise<void> {
    throw unsupportedProviderFeature('claude', 'archiveThread', 'Archive is not supported by Claude CLI instances');
  }

  async unarchiveThread(_threadId: string, _scopeId?: string | null): Promise<void> {
    throw unsupportedProviderFeature('claude', 'unarchiveThread', 'Unarchive is not supported by Claude CLI instances');
  }

  async startThread(options: StartThreadOptions): Promise<ThreadSessionState> {
    const session = this.createLocalSession({
      cwd: options.cwd ?? this.config.defaultCwd,
      model: options.model ?? this.config.claudeDefaultModel ?? DEFAULT_CLAUDE_MODEL_CATALOG[0],
    });
    return this.toThreadSessionState(session);
  }

  async resumeThread(options: ResumeThreadOptions): Promise<ThreadSessionState> {
    const session = this.getOrCreateSession(options.threadId);
    return this.toThreadSessionState(session);
  }

  async revealThread(_threadId: string): Promise<void> {
    throw unsupportedProviderFeature('claude', 'revealThread', 'Reveal is not supported by Claude CLI instances');
  }

  async startTurn(options: StartTurnOptions): Promise<TurnStartResult> {
    const turnId = `claude-turn-${crypto.randomBytes(8).toString('hex')}`;
    const itemId = `claude-item-${crypto.randomBytes(6).toString('hex')}`;
    const reasoningItemId = `claude-reason-${crypto.randomBytes(6).toString('hex')}`;
    const session = this.getOrCreateSession(options.threadId, {
      cwd: options.cwd ?? this.config.defaultCwd,
      model: options.model ?? this.config.claudeDefaultModel ?? DEFAULT_CLAUDE_MODEL_CATALOG[0],
    });
    const cwd = options.cwd ?? session.cwd ?? this.config.defaultCwd;
    const model = options.model ?? session.model ?? this.config.claudeDefaultModel ?? DEFAULT_CLAUDE_MODEL_CATALOG[0];
    const prompt = buildClaudePrompt(options.input, options.developerInstructions);
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
      includeDirectories: this.config.claudeIncludeDirectories ?? [],
      allowedTools: this.config.claudeAllowedTools ?? [],
      permissionMode: resolveClaudePermissionModeForAccess({
        approvalPolicy: options.approvalPolicy,
        sandboxMode: options.sandboxMode,
        fallbackMode: this.config.claudePermissionMode ?? 'default',
      }),
      timeoutMs: this.config.claudeHeadlessTimeoutMs ?? 15 * 60 * 1000,
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
          active.pendingError = 'Claude CLI headless turn timed out';
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
      latestAssistantText: '',
      sawStreamText: false,
      completed: false,
      interrupted: false,
      timeoutTriggered: false,
      stderr: [],
      pendingError: null,
      pendingDeltas: [],
      streamTimer: null,
      toolUses: new Map(),
    });

    return { id: turnId, status: 'in_progress' };
  }

  async steerTurn(_options: SteerTurnOptions): Promise<TurnSteerResult> {
    throw unsupportedProviderFeature('claude', 'steerTurn', 'Active-turn steering is not supported by Claude CLI instances');
  }

  async interruptTurn(_threadId: string, turnId: string, _scopeId?: string | null): Promise<void> {
    const active = this.activeTurns.get(turnId);
    if (!active) {
      return;
    }
    active.interrupted = true;
    active.process.cancel('SIGTERM');
  }

  async respond(_requestId: string | number, _result: unknown, _scopeId?: string | null): Promise<void> {
    throw unsupportedProviderFeature('claude', 'respond', 'Claude CLI provider does not support interactive server requests');
  }

  async respondError(_requestId: string | number, _message: string, _scopeId?: string | null): Promise<void> {
    throw unsupportedProviderFeature('claude', 'respondError', 'Claude CLI provider does not support interactive server requests');
  }

  async listModels(_scopeId?: string | null): Promise<ModelInfo[]> {
    const configured = [
      ...(this.config.claudeDefaultModel ? [this.config.claudeDefaultModel] : []),
      ...(this.config.claudeModelAllowlist ?? []),
    ]
      .map((entry) => entry.trim())
      .filter(Boolean);
    const unique = [...new Set(configured.length > 0 ? configured : DEFAULT_CLAUDE_MODEL_CATALOG)];
    return unique.map((model, index) => ({
      id: model,
      model,
      displayName: model,
      description: 'Configured Claude Code model',
      isDefault: index === 0,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: 'none' as const,
    }));
  }

  private handleStdoutLine(turnId: string, line: string): void {
    const active = this.activeTurns.get(turnId);
    if (!active || active.completed) {
      return;
    }
    const event = parseClaudeStreamLine(line);
    if (!event) {
      if (line.trim()) {
        this.logger.debug('claude.stdout.ignored', { line: line.trim() });
      }
      return;
    }
    this.handleClaudeEvent(active, event);
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
    this.logger.debug('claude.stderr', { turnId, line: trimmed });
  }

  private handleClaudeEvent(active: ClaudeActiveTurn, event: ClaudeStreamEvent): void {
    switch (event.type) {
      case 'system': {
        if (event.subtype !== 'init') {
          return;
        }
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
      case 'stream_event': {
        const delta = event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta'
          ? event.event.delta.text
          : null;
        if (!delta) {
          return;
        }
        active.sawStreamText = true;
        this.completeReasoningIfNeeded(active);
        this.startAssistantIfNeeded(active);
        this.enqueueClaudeDeltas(active, delta);
        return;
      }
      case 'assistant': {
        const content = event.message?.content ?? [];
        const textParts = content
          .filter((entry): entry is { type: 'text'; text?: string } => entry?.type === 'text')
          .map((entry) => entry.text?.trim() ?? '')
          .filter(Boolean);
        if (textParts.length > 0) {
          active.latestAssistantText = textParts.join('\n');
          if (!active.sawStreamText) {
            this.completeReasoningIfNeeded(active);
            this.startAssistantIfNeeded(active);
            this.enqueueClaudeDeltas(active, active.latestAssistantText);
          }
        }
        for (const item of content) {
          if (item?.type !== 'tool_use') {
            continue;
          }
          const toolId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
          const toolName = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'tool';
          const toolInput = item.input && typeof item.input === 'object'
            ? item.input as Record<string, unknown>
            : {};
          if (!toolId) {
            continue;
          }
          active.toolUses.set(toolId, { name: toolName, input: toolInput });
          this.emitToolNotification('codex/event/exec_command_begin', active, toolId, toolName, toolInput);
        }
        return;
      }
      case 'user': {
        const content = event.message?.content ?? [];
        for (const item of content) {
          if (item?.type !== 'tool_result') {
            continue;
          }
          const toolId = typeof item.tool_use_id === 'string' && item.tool_use_id.trim() ? item.tool_use_id.trim() : null;
          if (!toolId) {
            continue;
          }
          const tool = active.toolUses.get(toolId);
          this.emitToolNotification(
            'codex/event/exec_command_end',
            active,
            toolId,
            tool?.name ?? 'tool',
            tool?.input ?? {},
          );
        }
        return;
      }
      case 'rate_limit_event': {
        return;
      }
      case 'result': {
        this.completeReasoningIfNeeded(active);
        if (!active.finalText.trim() && active.pendingDeltas.length === 0) {
          const fallback = event.result?.trim() || active.latestAssistantText.trim();
          if (fallback) {
            this.startAssistantIfNeeded(active);
            this.enqueueClaudeDeltas(active, fallback);
          }
        }
        this.flushClaudeDeltas(active);
        this.completeAssistantIfNeeded(active);
        const errorText = active.pendingError ?? extractClaudeErrorText(event);
        this.completeTurn(active, event.is_error ? 'error' : 'success', errorText);
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
      this.completeTurn(active, 'error', active.pendingError ?? 'Claude CLI headless turn timed out');
      return;
    }
    if (code === 0 && !active.pendingError) {
      this.completeTurn(active, 'success', null);
      return;
    }
    const stderrText = active.stderr.join('\n').trim();
    const errorText = active.pendingError ?? (stderrText || `Claude CLI exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`);
    this.completeTurn(active, 'error', errorText);
  }

  private completeReasoningIfNeeded(active: ClaudeActiveTurn): void {
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

  private startAssistantIfNeeded(active: ClaudeActiveTurn): void {
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

  private completeAssistantIfNeeded(active: ClaudeActiveTurn): void {
    if (!active.assistantStarted) {
      if (!active.finalText.trim()) {
        return;
      }
      this.startAssistantIfNeeded(active);
    }
    this.flushClaudeDeltas(active);
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

  private completeTurn(active: ClaudeActiveTurn, status: 'success' | 'error' | 'interrupted', errorText: string | null): void {
    if (active.completed) {
      return;
    }
    active.completed = true;
    this.flushClaudeDeltas(active);
    if (status !== 'success') {
      this.logger.warn('claude.turn_failed', {
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

  private emitToolNotification(
    method: 'codex/event/exec_command_begin' | 'codex/event/exec_command_end',
    active: ClaudeActiveTurn,
    toolId: string,
    toolName: string,
    parameters: Record<string, unknown>,
  ): void {
    const parsedType = mapClaudeToolToParsedCmdType(toolName);
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

  private enqueueClaudeDeltas(active: ClaudeActiveTurn, content: string): void {
    const parts = chunkText(content, CLAUDE_STREAM_CHUNK_SIZE);
    active.pendingDeltas.push(...parts);
    if (!active.streamTimer) {
      this.scheduleClaudeDeltaFlush(active);
    }
  }

  private scheduleClaudeDeltaFlush(active: ClaudeActiveTurn): void {
    active.streamTimer = setTimeout(() => {
      active.streamTimer = null;
      if (active.completed) {
        return;
      }
      const next = active.pendingDeltas.shift();
      if (!next) {
        return;
      }
      active.finalText += next;
      this.emitNotification({
        method: 'item/agentMessage/delta',
        params: {
          turnId: active.turnId,
          itemId: active.itemId,
          phase: 'final',
          delta: next,
        },
      });
      if (active.pendingDeltas.length > 0) {
        this.scheduleClaudeDeltaFlush(active);
      }
    }, CLAUDE_STREAM_INTERVAL_MS);
  }

  private flushClaudeDeltas(active: ClaudeActiveTurn): void {
    if (active.streamTimer) {
      clearTimeout(active.streamTimer);
      active.streamTimer = null;
    }
    while (active.pendingDeltas.length > 0) {
      const next = active.pendingDeltas.shift();
      if (!next) {
        continue;
      }
      active.finalText += next;
      this.emitNotification({
        method: 'item/agentMessage/delta',
        params: {
          turnId: active.turnId,
          itemId: active.itemId,
          phase: 'final',
          delta: next,
        },
      });
    }
  }

  private emitNotification(notification: EngineNotification): void {
    this.emit('notification', notification);
  }

  private createLocalSession(input: { cwd: string; model: string | null }): ClaudeSessionRecord {
    const localThreadId = `claude-local-${crypto.randomBytes(8).toString('hex')}`;
    const session: ClaudeSessionRecord = {
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

  private bindActualSessionId(threadId: string, sessionId: string, cwd: string, model: string | null | undefined): ClaudeSessionRecord {
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

  private getOrCreateSession(threadId: string, seed?: { cwd: string | null; model: string | null }): ClaudeSessionRecord {
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
    const session: ClaudeSessionRecord = {
      localThreadId: threadId,
      canonicalThreadId: resolvedId,
      actualSessionId: resolvedId.startsWith('claude-local-') ? null : resolvedId,
      name: null,
      preview: '',
      cwd: seed?.cwd ?? this.config.defaultCwd,
      model: seed?.model ?? this.config.claudeDefaultModel ?? DEFAULT_CLAUDE_MODEL_CATALOG[0],
      updatedAt: Date.now(),
    };
    this.registerSession(session);
    return session;
  }

  private registerSession(session: ClaudeSessionRecord): void {
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

  private toAppThread(session: ClaudeSessionRecord): AppThread {
    return {
      threadId: session.canonicalThreadId,
      name: session.name,
      preview: session.preview,
      cwd: session.cwd,
      modelProvider: 'claude-code',
      status: 'idle',
      updatedAt: session.updatedAt,
    };
  }

  private toThreadSessionState(session: ClaudeSessionRecord): ThreadSessionState {
    return {
      thread: this.toAppThread(session),
      model: session.model ?? this.config.claudeDefaultModel ?? DEFAULT_CLAUDE_MODEL_CATALOG[0],
      modelProvider: 'claude-code',
      reasoningEffort: null,
      serviceTier: null,
      cwd: session.cwd ?? this.config.defaultCwd,
    };
  }
}

function extractClaudeErrorText(event: { error?: unknown; result?: unknown; is_error?: boolean }): string | null {
  if (!event.is_error) {
    return null;
  }
  const candidates = [event.error, event.result];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return 'Claude CLI returned an error result';
}

function chunkText(value: string, size: number): string[] {
  const chunks: string[] = [];
  if (!value) {
    return chunks;
  }
  const normalizedSize = Math.max(1, size);
  for (let index = 0; index < value.length; index += normalizedSize) {
    chunks.push(value.slice(index, index + normalizedSize));
  }
  return chunks;
}

export function resolveClaudePermissionModeForAccess(options: {
  approvalPolicy: StartTurnOptions['approvalPolicy'];
  sandboxMode: StartTurnOptions['sandboxMode'];
  fallbackMode: NonNullable<AppConfig['claudePermissionMode']>;
}): NonNullable<AppConfig['claudePermissionMode']> {
  if (options.sandboxMode === 'danger-full-access' || options.approvalPolicy === 'never') {
    return 'bypassPermissions';
  }
  if (options.sandboxMode === 'read-only') {
    return 'plan';
  }
  if (options.fallbackMode === 'acceptEdits' || options.fallbackMode === 'auto' || options.fallbackMode === 'dontAsk') {
    return options.fallbackMode;
  }
  return 'default';
}

function buildClaudePrompt(input: TurnInput[], developerInstructions: string | null): string {
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

function detectClaudeUserAgent(claudeCliBin: string): string {
  try {
    const result = spawnCommandSync(claudeCliBin, ['--version'], { encoding: 'utf8' });
    const version = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status === 0 && version) {
      return `claude-code/${version}`;
    }
  } catch {
    // ignore version lookup failures
  }
  return 'claude-code';
}

function readClaudeAccountIdentity(claudeCliBin: string): AccountIdentitySnapshot | null {
  try {
    const result = spawnCommandSync(claudeCliBin, ['auth', 'status', '--json'], { encoding: 'utf8' });
    if (result.status !== 0) {
      return null;
    }
    const parsed = JSON.parse(`${result.stdout || ''}`) as Record<string, unknown>;
    if (parsed.loggedIn !== true) {
      return null;
    }
    const email = typeof parsed.email === 'string' ? parsed.email : null;
    const authMode = typeof parsed.authMethod === 'string' ? parsed.authMethod : null;
    const orgName = typeof parsed.orgName === 'string' ? parsed.orgName : null;
    const orgId = typeof parsed.orgId === 'string' ? parsed.orgId : null;
    return {
      email,
      name: orgName,
      authMode,
      accountId: orgId,
    };
  } catch {
    return null;
  }
}

export function createClaudeEngineProvider(
  config: Pick<AppConfig, 'claudeCliBin' | 'claudeDefaultModel' | 'claudeModelAllowlist' | 'claudeIncludeDirectories' | 'claudeAllowedTools' | 'claudePermissionMode' | 'claudeHeadlessTimeoutMs' | 'defaultCwd'>,
  logger: Logger,
): ClaudeEngineProvider {
  return new ClaudeEngineProvider(config, logger);
}
