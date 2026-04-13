import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type {
  AppThread,
  AppThreadTurn,
  AppThreadTurnItem,
  AppThreadWithTurns,
  ModelInfo,
  ThreadSessionState,
} from '../types.js';
import {
  OpenCodeApiError,
  OpenCodeClient,
  type OpenCodeGlobalEvent,
  type OpenCodeMessageEntry,
  type OpenCodePart,
  type OpenCodePermissionRule,
  type OpenCodePermissionRequest,
  type OpenCodeProviderCatalog,
  type OpenCodeProviderModel,
  type OpenCodeQuestionRequest,
  type OpenCodeSession,
  type OpenCodeSessionStatus,
  type OpenCodeToolPart,
} from '../opencode_api/client.js';
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
import type { ReasoningEffortValue } from '../types.js';

interface OpenCodeSessionRecord {
  session: OpenCodeSession;
  preview: string;
  model: string | null;
  modelProvider: string | null;
  status: AppThread['status'];
}

interface OpenCodeActiveTurn {
  turnId: string;
  threadId: string;
  itemId: string;
  reasoningItemId: string;
  cwd: string;
  model: string | null;
  assistantStarted: boolean;
  reasoningCompleted: boolean;
  completed: boolean;
  interrupted: boolean;
  pendingError: string | null;
  assistantMessageId: string | null;
  assistantPartOrder: string[];
  assistantPartKinds: Map<string, 'text' | 'reasoning' | 'tool' | 'other'>;
  assistantPartTexts: Map<string, string>;
  emittedAssistantText: string;
  toolStates: Map<string, 'pending' | 'running' | 'completed' | 'error'>;
}

interface PendingServerRequest {
  kind: 'permission' | 'question';
  sessionId: string;
  turnId: string;
  directory: string | null;
  questionIds?: string[];
}

const OPENCODE_THREAD_HISTORY_LIMIT = 24;
const OPENCODE_BRIDGE_SYSTEM_INSTRUCTIONS = [
  'Return only user-facing reply text.',
  'Do not expose internal reasoning, self-instructions, or meta narration such as "The user is asking...", "I should...", or "Let me think...".',
  'Use tools silently unless the final answer needs a concise explanation of what changed.',
].join('\n');

export class OpenCodeEngineProvider extends EventEmitter implements EngineProvider {
  readonly engine = 'opencode' as const;
  readonly capabilities = {
    threads: true,
    reveal: false,
    guidedPlan: 'none',
    approvals: 'limited',
    steerActiveTurn: false,
    rateLimits: false,
    reasoningEffort: true,
    serviceTier: false,
    reconnect: true,
  } as const;

  private readonly client: OpenCodeClient;
  private readonly knownDirectories = new Set<string>();
  private readonly sessionRecords = new Map<string, OpenCodeSessionRecord>();
  private readonly activeTurns = new Map<string, OpenCodeActiveTurn>();
  private readonly activeTurnBySession = new Map<string, string>();
  private readonly pendingRequests = new Map<string, PendingServerRequest>();
  private modelsCache: OpenCodeProviderCatalog | null = null;
  private userAgent: string | null = null;

  constructor(
    private readonly config: Pick<
      AppConfig,
      'opencodeCliBin' | 'opencodeDefaultModel' | 'opencodeDefaultAgent' | 'opencodeServerHostname' | 'opencodeServerPort' | 'defaultCwd'
    >,
    private readonly logger: Logger,
  ) {
    super();
    this.client = new OpenCodeClient(config, logger);
    this.knownDirectories.add(config.defaultCwd);
    this.client.on('connected', () => {
      this.userAgent = this.client.getUserAgent();
      this.emit('connected');
    });
    this.client.on('disconnected', () => {
      this.emit('disconnected');
    });
    this.client.on('event', (event) => {
      void this.handleGlobalEvent(event).catch((error) => {
        this.logger.warn('opencode.event_handler_failed', { error: String(error) });
      });
    });
  }

  on(event: 'notification', listener: (message: EngineNotification) => void): this;
  on(event: 'serverRequest', listener: (message: EngineServerRequest) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  async start(): Promise<void> {
    await this.client.start();
  }

  async stop(): Promise<void> {
    this.activeTurns.clear();
    this.activeTurnBySession.clear();
    this.pendingRequests.clear();
    await this.client.stop();
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  getUserAgent(): string | null {
    return this.userAgent ?? 'opencode';
  }

  async listThreads(options: ListThreadsOptions): Promise<AppThread[]> {
    const sessions = await this.listSessionsAcrossKnownDirectories();
    const statuses = await this.safeListSessionStatuses();
    const searchTerm = options.searchTerm?.trim().toLowerCase() ?? null;
    const filtered = sessions
      .filter((session) => {
        const record = this.sessionRecords.get(session.id);
        if (!searchTerm) {
          return true;
        }
        return session.id.toLowerCase().includes(searchTerm)
          || session.slug.toLowerCase().includes(searchTerm)
          || session.directory.toLowerCase().includes(searchTerm)
          || session.title.toLowerCase().includes(searchTerm)
          || record?.preview.toLowerCase().includes(searchTerm) === true;
      })
      .sort((left, right) => right.time.updated - left.time.updated)
      .slice(0, options.limit);
    for (const session of filtered) {
      await this.ensureSessionRecord(session, statuses[session.id] ?? null);
    }
    return filtered.map((session) => this.toAppThread(this.sessionRecords.get(session.id) ?? this.toSessionRecord(session)));
  }

  async readThread(threadId: string): Promise<AppThread | null> {
    const record = await this.loadSessionRecord(threadId, false);
    return record ? this.toAppThread(record) : null;
  }

  async readThreadWithTurns(threadId: string): Promise<AppThreadWithTurns | null> {
    const record = await this.loadSessionRecord(threadId, true);
    if (!record) {
      return null;
    }
    const messages = await this.readThreadMessages(record.session.id, record.session.directory);
    return {
      ...this.toAppThread(record),
      turns: this.mapMessagesToTurns(messages),
    };
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    const record = await this.requireSessionRecord(threadId, false);
    const updated = await this.client.updateSession(record.session.id, { title: name.trim() || record.session.title }, record.session.directory);
    await this.ensureSessionRecord(updated, null);
  }

  async startThread(options: StartThreadOptions): Promise<ThreadSessionState> {
    const cwd = options.cwd ?? this.config.defaultCwd;
    this.knownDirectories.add(cwd);
    const permission = buildOpenCodePermissionRules(options.approvalPolicy, options.sandboxMode);
    const created = await this.client.createSession(cwd, null, permission);
    const record = await this.ensureSessionRecord(created, null);
    return this.toThreadSessionState(record, options.model ?? this.resolveDefaultModel());
  }

  async resumeThread(options: ResumeThreadOptions): Promise<ThreadSessionState> {
    const record = await this.requireSessionRecord(options.threadId, false);
    return this.toThreadSessionState(record, record.model ?? this.resolveDefaultModel());
  }

  async revealThread(_threadId: string): Promise<void> {
    throw unsupportedProviderFeature('opencode', 'revealThread', 'Reveal is not supported by OpenCode instances');
  }

  async startTurn(options: StartTurnOptions): Promise<TurnStartResult> {
    let record = await this.requireSessionRecord(options.threadId, false);
    const turnId = `opencode-turn-${crypto.randomBytes(8).toString('hex')}`;
    const itemId = `opencode-item-${crypto.randomBytes(6).toString('hex')}`;
    const reasoningItemId = `opencode-reason-${crypto.randomBytes(6).toString('hex')}`;
    const cwd = options.cwd ?? record.session.directory ?? this.config.defaultCwd;
    this.knownDirectories.add(cwd);
    const permission = buildOpenCodePermissionRules(options.approvalPolicy, options.sandboxMode);
    record = await this.ensureSessionPermission(record, permission);

    const activeTurn: OpenCodeActiveTurn = {
      turnId,
      threadId: record.session.id,
      itemId,
      reasoningItemId,
      cwd,
      model: options.model ?? this.config.opencodeDefaultModel ?? this.resolveDefaultModel(),
      assistantStarted: false,
      reasoningCompleted: false,
      completed: false,
      interrupted: false,
      pendingError: null,
      assistantMessageId: null,
      assistantPartOrder: [],
      assistantPartKinds: new Map(),
      assistantPartTexts: new Map(),
      emittedAssistantText: '',
      toolStates: new Map(),
    };
    this.activeTurns.set(turnId, activeTurn);
    this.activeTurnBySession.set(record.session.id, turnId);
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

    const promptBody: {
      model?: { providerID: string; modelID: string };
      agent?: string;
      system?: string | null;
      variant?: string | null;
      parts: Array<Record<string, unknown>>;
    } = {
      parts: buildOpenCodePromptParts(options.input),
    };
    const selectedModel = options.model ?? this.config.opencodeDefaultModel ?? null;
    const parsedModel = parseOpenCodeModel(selectedModel);
    if (parsedModel) {
      promptBody.model = parsedModel;
    }
    const variant = resolveOpenCodeVariant(
      selectedModel ?? this.resolveDefaultModel(),
      options.modelVariant ?? null,
      options.effort ?? null,
      this.modelsCache,
    );
    if (variant) {
      promptBody.variant = variant;
    }
    const agent = resolveOpenCodeAgent(this.config.opencodeDefaultAgent ?? null, options.collaborationMode);
    if (agent) {
      promptBody.agent = agent;
    }
    promptBody.system = composeOpenCodeSystemPrompt(options.developerInstructions);
    await this.client.promptAsync(record.session.id, promptBody, record.session.directory);

    return { id: turnId, status: 'in_progress', threadId: record.session.id };
  }

  async steerTurn(_options: SteerTurnOptions): Promise<TurnSteerResult> {
    throw unsupportedProviderFeature('opencode', 'steerTurn', 'Active-turn steering is not supported by OpenCode yet');
  }

  async interruptTurn(_threadId: string, turnId: string): Promise<void> {
    const active = this.activeTurns.get(turnId);
    if (!active) {
      return;
    }
    active.interrupted = true;
    await this.client.abortSession(active.threadId, active.cwd);
  }

  async respond(requestId: string | number, result: unknown): Promise<void> {
    const request = this.pendingRequests.get(String(requestId));
    if (!request) {
      return;
    }
    if (request.kind === 'permission') {
      const decision = normalizeApprovalDecision(result);
      await this.client.replyPermission(request.sessionId, String(requestId), decision, request.directory);
      this.pendingRequests.delete(String(requestId));
      return;
    }
    const answersRecord = typeof result === 'object' && result && 'answers' in result
      ? (result as { answers?: Record<string, { answers?: string[] }> }).answers ?? {}
      : {};
    const orderedAnswers = (request.questionIds ?? []).map((questionId) => {
      const answers = answersRecord[questionId]?.answers ?? [];
      return answers.map((entry) => String(entry));
    });
    await this.client.replyQuestion(String(requestId), orderedAnswers);
    this.pendingRequests.delete(String(requestId));
  }

  async respondError(requestId: string | number, _message: string): Promise<void> {
    const request = this.pendingRequests.get(String(requestId));
    if (!request) {
      return;
    }
    if (request.kind === 'permission') {
      await this.client.replyPermission(request.sessionId, String(requestId), 'reject', request.directory);
      this.pendingRequests.delete(String(requestId));
      return;
    }
    await this.client.rejectQuestion(String(requestId));
    this.pendingRequests.delete(String(requestId));
  }

  async listModels(): Promise<ModelInfo[]> {
    const catalog = await this.client.listProviders();
    this.modelsCache = catalog;
    const defaultMap = catalog.default;
    return catalog.providers
      .flatMap((provider) => Object.values(provider.models).map((model) => ({
        id: `${provider.id}/${model.id}`,
        model: `${provider.id}/${model.id}`,
        displayName: `${provider.name}: ${model.name}`,
        description: 'OpenCode provider model',
        isDefault: defaultMap[provider.id] === model.id,
        supportedReasoningEfforts: listOpenCodeReasoningEfforts(model),
        defaultReasoningEffort: resolveDefaultOpenCodeReasoningEffort(listOpenCodeReasoningEfforts(model)),
        supportedVariants: listOpenCodeVariants(model),
        variantReasoningEfforts: listOpenCodeVariantReasoningEfforts(model),
      })))
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.model.localeCompare(right.model));
  }

  private async handleGlobalEvent(event: OpenCodeGlobalEvent): Promise<void> {
    if (event.directory) {
      this.knownDirectories.add(event.directory);
    }
    const payload = event.payload;
    switch (payload.type) {
      case 'session.created':
      case 'session.updated': {
        const session = payload.properties?.info as OpenCodeSession | undefined;
        if (session?.id) {
          const existing = this.sessionRecords.get(session.id);
          this.sessionRecords.set(session.id, {
            session,
            preview: existing?.preview ?? '',
            model: existing?.model ?? null,
            modelProvider: existing?.modelProvider ?? null,
            status: existing?.status ?? 'idle',
          });
        }
        return;
      }
      case 'session.deleted': {
        const session = payload.properties?.info as OpenCodeSession | undefined;
        if (session?.id) {
          this.sessionRecords.delete(session.id);
        }
        return;
      }
      case 'session.status': {
        const sessionId = typeof payload.properties?.sessionID === 'string' ? payload.properties.sessionID : null;
        const status = payload.properties?.status as OpenCodeSessionStatus | undefined;
        if (!sessionId || !status) {
          return;
        }
        this.updateSessionStatus(sessionId, status);
        return;
      }
      case 'session.error': {
        const sessionId = typeof payload.properties?.sessionID === 'string' ? payload.properties.sessionID : null;
        if (!sessionId) {
          return;
        }
        const active = this.findActiveTurnBySession(sessionId);
        if (active) {
          active.pendingError = extractOpenCodeErrorText(payload.properties?.error) ?? 'OpenCode turn failed';
        }
        return;
      }
      case 'session.idle': {
        const sessionId = typeof payload.properties?.sessionID === 'string' ? payload.properties.sessionID : null;
        if (!sessionId) {
          return;
        }
        this.updateSessionStatus(sessionId, { type: 'idle' });
        const active = this.findActiveTurnBySession(sessionId);
        if (active) {
          this.completeTurn(active);
        }
        return;
      }
      case 'message.updated': {
        await this.handleMessageUpdated(payload.properties);
        return;
      }
      case 'message.part.updated': {
        this.handlePartUpdated(payload.properties?.part as OpenCodePart | undefined);
        return;
      }
      case 'message.part.delta': {
        this.handlePartDelta(payload.properties);
        return;
      }
      case 'permission.asked': {
        this.handlePermissionAsked(payload.properties as OpenCodePermissionRequest);
        return;
      }
      case 'question.asked': {
        this.handleQuestionAsked(payload.properties as OpenCodeQuestionRequest);
      }
    }
  }

  private async handleMessageUpdated(properties: any): Promise<void> {
    const info = properties?.info as OpenCodeMessageEntry['info'] | undefined;
    if (!info || info.role !== 'assistant') {
      return;
    }
    const active = this.findActiveTurnBySession(info.sessionID);
    if (!active) {
      return;
    }
    active.assistantMessageId = info.id;
    const record = this.sessionRecords.get(info.sessionID);
    if (record) {
      record.modelProvider = info.providerID ?? record.modelProvider;
      record.model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : record.model;
      record.session = {
        ...record.session,
        directory: info.path?.cwd ?? record.session.directory,
      };
    }
    if (info.error) {
      const errorText = extractOpenCodeErrorText(info.error) ?? 'OpenCode assistant error';
      if (active.interrupted || /abort/i.test(errorText)) {
        active.interrupted = true;
      } else {
        active.pendingError = errorText;
      }
    }
  }

  private handlePartUpdated(part: OpenCodePart | undefined): void {
    if (!part || typeof part !== 'object') {
      return;
    }
    if (!('sessionID' in part) || typeof (part as any).sessionID !== 'string') {
      return;
    }
    const sessionId = String((part as any).sessionID);
    const active = this.findActiveTurnBySession(sessionId);
    if (!active || active.completed) {
      return;
    }
    const messageId = extractOpenCodePartMessageId(part);
    if (!messageId || !active.assistantMessageId || messageId !== active.assistantMessageId) {
      return;
    }
    if (isOpenCodeReasoningPart(part)) {
      active.assistantPartKinds.set(part.id, 'reasoning');
      if (!active.reasoningCompleted && isOpenCodeCompletedPart(part)) {
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
      return;
    }
    if (isOpenCodeTextPart(part)) {
      active.assistantPartKinds.set(part.id, 'text');
      this.appendAssistantText(active, part.id, part.text);
      return;
    }
    if (isOpenCodeToolPart(part)) {
      active.assistantPartKinds.set(part.id, 'tool');
      this.updateToolPart(active, part);
      return;
    }
    active.assistantPartKinds.set(part.id, 'other');
  }

  private handlePartDelta(properties: any): void {
    const sessionId = typeof properties?.sessionID === 'string' ? properties.sessionID : null;
    const messageId = typeof properties?.messageID === 'string' ? properties.messageID : null;
    const partId = typeof properties?.partID === 'string' ? properties.partID : null;
    const field = typeof properties?.field === 'string' ? properties.field : null;
    const delta = typeof properties?.delta === 'string' ? properties.delta : null;
    if (!sessionId || !messageId || !partId || field !== 'text' || delta === null) {
      return;
    }
    const active = this.findActiveTurnBySession(sessionId);
    if (!active || active.completed) {
      return;
    }
    if (!active.assistantMessageId || messageId !== active.assistantMessageId) {
      return;
    }
    const partKind = active.assistantPartKinds.get(partId) ?? 'other';
    if (partKind !== 'text') {
      return;
    }
    const previous = active.assistantPartTexts.get(partId) ?? '';
    active.assistantPartTexts.set(partId, `${previous}${delta}`);
    if (!active.assistantPartOrder.includes(partId)) {
      active.assistantPartOrder.push(partId);
    }
    this.syncAssistantVisibleText(active);
  }

  private handlePermissionAsked(request: OpenCodePermissionRequest): void {
    const active = this.findActiveTurnBySession(request.sessionID);
    if (!active) {
      return;
    }
    this.pendingRequests.set(request.id, {
      kind: 'permission',
      sessionId: request.sessionID,
      turnId: active.turnId,
      directory: active.cwd,
    });
    const method = request.permission === 'edit' || request.permission === 'external_directory'
      ? 'item/fileChange/requestApproval'
      : 'item/commandExecution/requestApproval';
    this.emitServerRequest({
      id: request.id,
      method,
      params: buildApprovalParams(request, active),
    });
  }

  private handleQuestionAsked(request: OpenCodeQuestionRequest): void {
    const active = this.findActiveTurnBySession(request.sessionID);
    if (!active) {
      return;
    }
    const questionIds = request.questions.map((_, index) => `question-${index + 1}`);
    this.pendingRequests.set(request.id, {
      kind: 'question',
      sessionId: request.sessionID,
      turnId: active.turnId,
      directory: active.cwd,
      questionIds,
    });
    this.emitServerRequest({
      id: request.id,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: request.sessionID,
        turnId: active.turnId,
        itemId: request.tool?.callID ?? request.id,
        questions: request.questions.map((question, index) => ({
          id: questionIds[index]!,
          header: question.header,
          question: question.question,
          isOther: question.custom !== false,
          isSecret: false,
          options: question.options,
        })),
      },
    });
  }

  private updateToolPart(active: OpenCodeActiveTurn, part: OpenCodeToolPart): void {
    const previousStatus = active.toolStates.get(part.callID) ?? null;
    const nextStatus = part.state.status;
    const quietTool = shouldQuietOpenCodeTool(part);
    if ((nextStatus === 'pending' || nextStatus === 'running') && previousStatus === null) {
      active.toolStates.set(part.callID, nextStatus);
      if (!quietTool) {
        this.emitToolNotification('codex/event/exec_command_begin', active, part);
      }
      return;
    }
    if ((nextStatus === 'completed' || nextStatus === 'error') && previousStatus !== 'completed' && previousStatus !== 'error') {
      active.toolStates.set(part.callID, nextStatus);
      this.emitToolNotification('codex/event/exec_command_end', active, part);
    }
  }

  private emitToolNotification(
    method: 'codex/event/exec_command_begin' | 'codex/event/exec_command_end',
    active: OpenCodeActiveTurn,
    part: OpenCodeToolPart,
  ): void {
    const command = resolveOpenCodeToolCommand(part);
    const parsedCmd = mapOpenCodeToolToParsedCmd(part);
    this.emitNotification({
      method,
      params: {
        msg: {
          call_id: part.callID,
          turn_id: active.turnId,
          command,
          cwd: active.cwd,
          parsed_cmd: parsedCmd.length > 0 ? parsedCmd : [],
        },
      },
    });
  }

  private appendAssistantText(active: OpenCodeActiveTurn, partId: string, nextText: string): void {
    active.assistantPartTexts.set(partId, nextText);
    if (!active.assistantPartOrder.includes(partId)) {
      active.assistantPartOrder.push(partId);
    }
    this.syncAssistantVisibleText(active);
  }

  private startAssistantIfNeeded(active: OpenCodeActiveTurn): void {
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

  private refreshActivePreview(active: OpenCodeActiveTurn): void {
    const record = this.sessionRecords.get(active.threadId);
    if (!record) {
      return;
    }
    record.preview = buildVisibleAssistantPreview(active);
    record.status = 'active';
  }

  private completeTurn(active: OpenCodeActiveTurn): void {
    if (active.completed) {
      return;
    }
    active.completed = true;
    const finalText = buildVisibleAssistantPreview(active);
    if (active.assistantStarted) {
      this.emitNotification({
        method: 'item/completed',
        params: {
          turnId: active.turnId,
          item: {
            id: active.itemId,
            type: 'agentMessage',
            phase: 'final',
            text: finalText,
          },
        },
      });
    } else if (finalText.trim()) {
      this.startAssistantIfNeeded(active);
      this.emitNotification({
        method: 'item/completed',
        params: {
          turnId: active.turnId,
          item: {
            id: active.itemId,
            type: 'agentMessage',
            phase: 'final',
            text: finalText,
          },
        },
      });
    }
    const status = active.interrupted
      ? 'interrupted'
      : active.pendingError
        ? 'error'
        : 'success';
    const record = this.sessionRecords.get(active.threadId);
    if (record) {
      record.preview = finalText.trim() || record.preview;
      record.status = status === 'success' ? 'idle' : status === 'interrupted' ? 'idle' : 'systemError';
    }
    this.emitNotification({
      method: 'turn/completed',
      params: {
        turnId: active.turnId,
        status,
        error: active.pendingError,
        result: {
          status,
          error: active.pendingError,
        },
      },
    });
    this.activeTurns.delete(active.turnId);
    this.activeTurnBySession.delete(active.threadId);
  }

  private async requireSessionRecord(threadId: string, includePreview: boolean): Promise<OpenCodeSessionRecord> {
    const record = await this.loadSessionRecord(threadId, includePreview);
    if (!record) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return record;
  }

  private async loadSessionRecord(threadId: string, includePreview: boolean): Promise<OpenCodeSessionRecord | null> {
    const cached = this.sessionRecords.get(threadId);
    if (cached && (!includePreview || cached.preview)) {
      return cached;
    }
    const knownDirectories = [cached?.session.directory ?? null, ...this.knownDirectories]
      .filter((value): value is string => Boolean(value));
    for (const directory of new Set(knownDirectories)) {
      try {
        const session = await this.client.getSession(threadId, directory);
        return this.ensureSessionRecord(session, null, includePreview);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }
    try {
      const session = await this.client.getSession(threadId);
      return this.ensureSessionRecord(session, null, includePreview);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private async ensureSessionRecord(
    session: OpenCodeSession,
    status: OpenCodeSessionStatus | null,
    includePreview = true,
  ): Promise<OpenCodeSessionRecord> {
    this.knownDirectories.add(session.directory);
    const existing = this.sessionRecords.get(session.id);
    const record: OpenCodeSessionRecord = {
      session,
      preview: existing?.preview ?? '',
      model: existing?.model ?? null,
      modelProvider: existing?.modelProvider ?? null,
      status: mapOpenCodeSessionStatus(status ?? null),
    };
    if (includePreview && !record.preview) {
      const messages = await this.readThreadMessages(session.id, session.directory);
      record.preview = extractThreadPreview(messages) ?? session.title;
      const assistantMessage = [...messages].reverse().find((message) => message.info.role === 'assistant');
      if (assistantMessage?.info.providerID && assistantMessage.info.modelID) {
        record.modelProvider = assistantMessage.info.providerID;
        record.model = `${assistantMessage.info.providerID}/${assistantMessage.info.modelID}`;
      }
    }
    this.sessionRecords.set(session.id, record);
    return record;
  }

  private async readThreadMessages(sessionID: string, directory: string | null): Promise<OpenCodeMessageEntry[]> {
    const messages = await this.client.getSessionMessages(sessionID, {
      directory,
      limit: OPENCODE_THREAD_HISTORY_LIMIT,
    });
    return [...messages].sort((left, right) => left.info.time.created - right.info.time.created);
  }

  private async listSessionsAcrossKnownDirectories(): Promise<OpenCodeSession[]> {
    const results = new Map<string, OpenCodeSession>();
    for (const directory of this.knownDirectories) {
      try {
        const sessions = await this.client.listSessions(directory);
        for (const session of sessions) {
          results.set(session.id, session);
        }
      } catch (error) {
        this.logger.warn('opencode.list_sessions_failed', { directory, error: String(error) });
      }
    }
    return [...results.values()];
  }

  private async safeListSessionStatuses(): Promise<Record<string, OpenCodeSessionStatus>> {
    try {
      return await this.client.getSessionStatuses();
    } catch (error) {
      this.logger.warn('opencode.session_status_failed', { error: String(error) });
      return {};
    }
  }

  private updateSessionStatus(sessionId: string, status: OpenCodeSessionStatus): void {
    const record = this.sessionRecords.get(sessionId);
    if (!record) {
      return;
    }
    record.status = mapOpenCodeSessionStatus(status);
  }

  private findActiveTurnBySession(sessionId: string): OpenCodeActiveTurn | null {
    const turnId = this.activeTurnBySession.get(sessionId);
    if (!turnId) {
      return null;
    }
    return this.activeTurns.get(turnId) ?? null;
  }

  private toSessionRecord(session: OpenCodeSession): OpenCodeSessionRecord {
    return {
      session,
      preview: session.title,
      model: null,
      modelProvider: null,
      status: 'idle',
    };
  }

  private toAppThread(record: OpenCodeSessionRecord): AppThread {
    return {
      threadId: record.session.id,
      name: record.session.title || null,
      preview: record.preview || record.session.title || record.session.slug,
      cwd: record.session.directory,
      modelProvider: record.modelProvider ?? 'opencode',
      status: record.status,
      updatedAt: record.session.time.updated,
    };
  }

  private toThreadSessionState(record: OpenCodeSessionRecord, model: string | null): ThreadSessionState {
    return {
      thread: this.toAppThread(record),
      model: model ?? '',
      modelProvider: record.modelProvider ?? 'opencode',
      reasoningEffort: null,
      modelVariant: null,
      serviceTier: null,
      cwd: record.session.directory,
    };
  }

  private resolveDefaultModel(): string | null {
    if (this.config.opencodeDefaultModel) {
      return this.config.opencodeDefaultModel;
    }
    if (!this.modelsCache) {
      return null;
    }
    for (const provider of this.modelsCache.providers) {
      const modelId = this.modelsCache.default[provider.id];
      if (modelId) {
        return `${provider.id}/${modelId}`;
      }
    }
    return null;
  }

  private mapMessagesToTurns(messages: OpenCodeMessageEntry[]): AppThreadTurn[] {
    const userMessages = new Map(messages.filter((entry) => entry.info.role === 'user').map((entry) => [entry.info.id, entry]));
    const turns: AppThreadTurn[] = [];
    const usedUserMessages = new Set<string>();
    for (const entry of messages) {
      if (entry.info.role !== 'assistant') {
        continue;
      }
      const items: AppThreadTurnItem[] = [];
      const parent = entry.info.parentID ? userMessages.get(entry.info.parentID) ?? null : null;
      if (parent) {
        usedUserMessages.add(parent.info.id);
        items.push(...extractThreadItems(parent, 'user_message', 'input'));
      }
      items.push(...extractAssistantThreadItems(entry));
      turns.push({
        id: entry.info.id,
        status: entry.info.error ? 'failed' : entry.info.time.completed ? 'completed' : 'active',
        error: extractOpenCodeErrorText(entry.info.error),
        items,
      });
    }
    for (const entry of messages) {
      if (entry.info.role !== 'user' || usedUserMessages.has(entry.info.id)) {
        continue;
      }
      turns.push({
        id: entry.info.id,
        status: 'completed',
        error: null,
        items: extractThreadItems(entry, 'user_message', 'input'),
      });
    }
    return turns.sort((left, right) => compareTurnIds(messages, left.id, right.id));
  }

  private emitNotification(notification: EngineNotification): void {
    this.emit('notification', notification);
  }

  private emitServerRequest(request: EngineServerRequest): void {
    this.emit('serverRequest', request);
  }

  private async ensureSessionPermission(
    record: OpenCodeSessionRecord,
    permission: OpenCodePermissionRule[],
  ): Promise<OpenCodeSessionRecord> {
    let currentRecord = record;
    if (!currentRecord.session.permission || currentRecord.session.permission.length === 0) {
      try {
        const refreshed = await this.client.getSession(currentRecord.session.id, currentRecord.session.directory);
        currentRecord = await this.ensureSessionRecord(refreshed, null, false);
        currentRecord.preview ||= record.preview;
        currentRecord.model ??= record.model;
        currentRecord.modelProvider ??= record.modelProvider;
      } catch (error) {
        this.logger.warn('opencode.session_permission_refresh_failed', {
          sessionId: currentRecord.session.id,
          directory: currentRecord.session.directory,
          error: String(error),
        });
      }
    }
    if (openCodePermissionRulesEqual(currentRecord.session.permission, permission)) {
      return currentRecord;
    }
    const replacement = await this.client.createSession(
      currentRecord.session.directory,
      currentRecord.session.title,
      permission,
      currentRecord.session.id,
    );
    const next = await this.ensureSessionRecord(replacement, null, false);
    next.preview ||= currentRecord.preview;
    next.model ??= currentRecord.model;
    next.modelProvider ??= currentRecord.modelProvider;
    next.status = currentRecord.status;
    this.logger.info('opencode.session_permission_recreated', {
      previousSessionId: currentRecord.session.id,
      nextSessionId: next.session.id,
      directory: currentRecord.session.directory,
    });
    return next;
  }

  private syncAssistantVisibleText(active: OpenCodeActiveTurn): void {
    const nextText = buildVisibleAssistantPreview(active);
    if (!nextText) {
      this.refreshActivePreview(active);
      return;
    }
    const previousText = active.emittedAssistantText;
    const delta = nextText.startsWith(previousText) ? nextText.slice(previousText.length) : null;
    if (!delta) {
      this.refreshActivePreview(active);
      return;
    }
    this.startAssistantIfNeeded(active);
    if (!active.reasoningCompleted) {
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
    active.emittedAssistantText = nextText;
    this.emitNotification({
      method: 'item/agentMessage/delta',
      params: {
        turnId: active.turnId,
        itemId: active.itemId,
        delta,
        phase: 'final',
      },
    });
    this.refreshActivePreview(active);
  }
}

export function createOpenCodeEngineProvider(
  config: Pick<
    AppConfig,
    'opencodeCliBin' | 'opencodeDefaultModel' | 'opencodeDefaultAgent' | 'opencodeServerHostname' | 'opencodeServerPort' | 'defaultCwd'
  >,
  logger: Logger,
): OpenCodeEngineProvider {
  return new OpenCodeEngineProvider(config, logger);
}

function mapOpenCodeSessionStatus(status: OpenCodeSessionStatus | null): AppThread['status'] {
  if (status?.type === 'busy') {
    return 'active';
  }
  if (status?.type === 'retry') {
    return 'active';
  }
  return 'idle';
}

function buildOpenCodePromptParts(input: TurnInput[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const item of input) {
    if (item.type === 'text') {
      if (!item.text.trim()) {
        continue;
      }
      parts.push({
        type: 'text',
        text: item.text,
      });
      continue;
    }
    parts.push({
      type: 'file',
      mime: inferMimeTypeFromPath(item.path),
      filename: path.basename(item.path),
      url: pathToFileURL(item.path).toString(),
    });
  }
  return parts;
}

function inferMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

function resolveOpenCodeAgent(defaultAgent: string | null, collaborationMode: StartTurnOptions['collaborationMode']): string {
  if (collaborationMode === 'plan') {
    return 'plan';
  }
  return defaultAgent?.trim() || 'build';
}

function composeOpenCodeSystemPrompt(developerInstructions: string | null | undefined): string {
  const extra = developerInstructions?.trim();
  return extra
    ? `${extra}\n\n${OPENCODE_BRIDGE_SYSTEM_INSTRUCTIONS}`
    : OPENCODE_BRIDGE_SYSTEM_INSTRUCTIONS;
}

function parseOpenCodeModel(value: string | null): { providerID: string; modelID: string } | null {
  if (!value || !value.includes('/')) {
    return null;
  }
  const slashIndex = value.indexOf('/');
  const providerID = value.slice(0, slashIndex).trim();
  const modelID = value.slice(slashIndex + 1).trim();
  if (!providerID || !modelID) {
    return null;
  }
  return { providerID, modelID };
}

const OPENCODE_REASONING_EFFORT_ORDER: ReasoningEffortValue[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const OPENCODE_REASONING_EFFORT_DEFAULT_PRIORITY: ReasoningEffortValue[] = ['medium', 'high', 'low', 'minimal', 'xhigh', 'none'];

function isReasoningEffortValue(value: string): value is ReasoningEffortValue {
  return OPENCODE_REASONING_EFFORT_ORDER.includes(value as ReasoningEffortValue);
}

function listOpenCodeReasoningEfforts(model: OpenCodeProviderModel): ReasoningEffortValue[] {
  const variantKeys = listOpenCodeVariants(model);
  return variantKeys
    .filter(isReasoningEffortValue)
    .sort((left, right) => OPENCODE_REASONING_EFFORT_ORDER.indexOf(left) - OPENCODE_REASONING_EFFORT_ORDER.indexOf(right));
}

function listOpenCodeVariants(model: OpenCodeProviderModel): string[] {
  return Object.keys(model.variants ?? {}).sort((left, right) => {
    const leftPriority = OPENCODE_REASONING_EFFORT_ORDER.indexOf(left as ReasoningEffortValue);
    const rightPriority = OPENCODE_REASONING_EFFORT_ORDER.indexOf(right as ReasoningEffortValue);
    if (leftPriority >= 0 && rightPriority >= 0) {
      return leftPriority - rightPriority;
    }
    if (leftPriority >= 0) {
      return -1;
    }
    if (rightPriority >= 0) {
      return 1;
    }
    return left.localeCompare(right);
  });
}

function resolveDefaultOpenCodeReasoningEffort(supported: ReasoningEffortValue[]): ReasoningEffortValue {
  for (const effort of OPENCODE_REASONING_EFFORT_DEFAULT_PRIORITY) {
    if (supported.includes(effort)) {
      return effort;
    }
  }
  return 'none';
}

function resolveOpenCodeVariant(
  modelRef: string | null,
  modelVariant: string | null,
  effort: ReasoningEffortValue | null,
  catalog: OpenCodeProviderCatalog | null,
): string | null {
  if (modelVariant) {
    if (!catalog || !modelRef) {
      return modelVariant;
    }
    const parsed = parseOpenCodeModel(modelRef);
    if (!parsed) {
      return modelVariant;
    }
    const provider = catalog.providers.find((entry) => entry.id === parsed.providerID);
    const model = provider?.models[parsed.modelID];
    if (!model) {
      return modelVariant;
    }
    return model.variants?.[modelVariant] ? modelVariant : null;
  }
  if (!effort) {
    return null;
  }
  if (!catalog || !modelRef) {
    return effort;
  }
  const parsed = parseOpenCodeModel(modelRef);
  if (!parsed) {
    return effort;
  }
  const provider = catalog.providers.find((entry) => entry.id === parsed.providerID);
  const model = provider?.models[parsed.modelID];
  if (!model) {
    return effort;
  }
  return model.variants?.[effort] ? effort : null;
}

function listOpenCodeVariantReasoningEfforts(model: OpenCodeProviderModel): Record<string, ReasoningEffortValue | null> {
  const entries = listOpenCodeVariants(model)
    .map((variant) => [variant, resolveOpenCodeVariantReasoningEffort(model, variant)] as const)
    .filter((entry): entry is readonly [string, ReasoningEffortValue | null] => entry[1] !== undefined);
  return Object.fromEntries(entries);
}

function resolveOpenCodeVariantReasoningEffort(
  model: OpenCodeProviderModel,
  variant: string,
): ReasoningEffortValue | null | undefined {
  if (isReasoningEffortValue(variant)) {
    return variant;
  }
  const config = model.variants?.[variant];
  if (!config || typeof config !== 'object') {
    return undefined;
  }
  const explicit = typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null;
  if (explicit && isReasoningEffortValue(explicit)) {
    return explicit;
  }
  return null;
}

function buildAssistantPreview(active: OpenCodeActiveTurn): string {
  return active.assistantPartOrder
    .map((partId) => active.assistantPartTexts.get(partId) ?? '')
    .join('')
    .trim();
}

function buildVisibleAssistantPreview(active: OpenCodeActiveTurn): string {
  return sanitizeOpenCodeAssistantText(buildAssistantPreview(active));
}

function extractThreadPreview(messages: OpenCodeMessageEntry[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || entry.info.role !== 'assistant') {
      continue;
    }
    const text = extractMessageText(entry.parts, true);
    if (text) {
      return text;
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry) {
      continue;
    }
    const text = extractMessageText(entry.parts, false);
    if (text) {
      return text;
    }
  }
  return null;
}

function extractThreadItems(entry: OpenCodeMessageEntry, type: 'user_message' | 'assistant_message', phase: string): AppThreadTurnItem[] {
  const text = extractMessageText(entry.parts, false);
  if (!text) {
    return [];
  }
  return [{
    id: entry.info.id,
    type,
    phase,
    text,
  }];
}

function extractAssistantThreadItems(entry: OpenCodeMessageEntry): AppThreadTurnItem[] {
  const items: AppThreadTurnItem[] = [];
  for (const part of entry.parts) {
    if (isOpenCodeTextPart(part)) {
      const text = sanitizeOpenCodeAssistantText(part.text);
      if (!text) {
        continue;
      }
      items.push({
        id: part.id,
        type: 'assistant_message',
        phase: 'final',
        text,
      });
    }
  }
  if (items.length === 0) {
    const text = extractMessageText(entry.parts, false);
    if (text) {
      items.push({
        id: entry.info.id,
        type: 'assistant_message',
        phase: 'final',
        text,
      });
    }
  }
  return items;
}

function extractMessageText(parts: OpenCodePart[], preferTextOnly: boolean): string | null {
  const collected = parts
    .flatMap((part) => {
      if (isOpenCodeTextPart(part)) {
        return [part.text];
      }
      if (!preferTextOnly && isOpenCodeReasoningPart(part)) {
        return [part.text];
      }
      if (!preferTextOnly && isOpenCodeToolPart(part) && part.state.status === 'completed' && part.state.title) {
        return [part.state.title];
      }
      return [];
    })
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (collected.length === 0) {
    return null;
  }
  const joined = collected.join('\n\n');
  if (!preferTextOnly) {
    return joined;
  }
  return sanitizeOpenCodeAssistantText(joined) || null;
}

function buildOpenCodePermissionRules(
  approvalPolicy: StartThreadOptions['approvalPolicy'],
  sandboxMode: StartThreadOptions['sandboxMode'],
): Array<{ permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' }> {
  if (sandboxMode === 'danger-full-access' || approvalPolicy === 'never') {
    return [{ permission: '*', pattern: '*', action: 'allow' }];
  }
  if (sandboxMode === 'read-only') {
    return [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'deny' },
      { permission: 'task', pattern: '*', action: 'ask' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
    ];
  }
  return [
    { permission: '*', pattern: '*', action: 'allow' },
    { permission: 'edit', pattern: '*', action: 'ask' },
    { permission: 'bash', pattern: '*', action: 'ask' },
    { permission: 'task', pattern: '*', action: 'ask' },
    { permission: 'external_directory', pattern: '*', action: 'ask' },
    { permission: 'doom_loop', pattern: '*', action: 'ask' },
  ];
}

function openCodePermissionRulesEqual(
  left: readonly OpenCodePermissionRule[] | null | undefined,
  right: readonly OpenCodePermissionRule[] | null | undefined,
): boolean {
  return JSON.stringify(normalizeOpenCodePermissionRules(left)) === JSON.stringify(normalizeOpenCodePermissionRules(right));
}

function normalizeOpenCodePermissionRules(
  rules: readonly OpenCodePermissionRule[] | null | undefined,
): OpenCodePermissionRule[] {
  return [...(rules ?? [])]
    .map((entry) => ({
      permission: entry.permission,
      pattern: entry.pattern,
      action: entry.action,
    }))
    .sort((left, right) =>
      left.permission.localeCompare(right.permission)
      || left.pattern.localeCompare(right.pattern)
      || left.action.localeCompare(right.action));
}

function buildApprovalParams(request: OpenCodePermissionRequest, active: OpenCodeActiveTurn): Record<string, unknown> {
  const base = {
    threadId: request.sessionID,
    turnId: active.turnId,
    itemId: request.tool?.callID ?? request.id,
    approvalId: request.id,
    cwd: active.cwd,
    reason: `OpenCode requested permission for ${request.permission}`,
  };
  if (request.permission === 'edit' || request.permission === 'external_directory') {
    return {
      ...base,
      changes: request.patterns.map((pattern) => ({
        path: String(request.metadata.filepath ?? request.metadata.parentDir ?? pattern),
        kind: request.permission === 'edit' ? 'update' : 'read',
      })),
    };
  }
  const command = request.permission === 'bash'
    ? request.patterns[0] ?? 'bash'
    : `${request.permission} ${request.patterns[0] ?? ''}`.trim();
  return {
    ...base,
    command,
    parsedCmd: mapPermissionToParsedCmd(request.permission, command),
  };
}

function mapPermissionToParsedCmd(permission: string, command: string): Array<Record<string, unknown>> {
  if (permission === 'bash') {
    const normalized = command.toLowerCase();
    if (normalized.startsWith('grep ') || normalized.startsWith('rg ')) {
      return [{ type: 'search' }];
    }
    if (normalized.startsWith('cat ') || normalized.startsWith('sed ') || normalized.startsWith('less ')) {
      return [{ type: 'read' }];
    }
    if (normalized.includes('apply_patch') || normalized.startsWith('patch ')) {
      return [{ type: 'apply_patch' }];
    }
    return [{ type: 'run' }];
  }
  if (permission === 'read' || permission === 'list' || permission === 'glob') {
    return [{ type: 'read' }];
  }
  if (permission === 'grep' || permission === 'websearch' || permission === 'codesearch') {
    return [{ type: 'search' }];
  }
  if (permission === 'edit') {
    return [{ type: 'edit' }];
  }
  return [];
}

function resolveOpenCodeToolCommand(part: OpenCodeToolPart): string[] {
  if (part.tool === 'bash') {
    const command = part.state.input?.command;
    if (typeof command === 'string' && command.trim()) {
      return [command];
    }
  }
  return [part.tool];
}

function mapOpenCodeToolToParsedCmd(part: OpenCodeToolPart): Array<Record<string, unknown>> {
  const tool = part.tool.toLowerCase();
  const input = part.state.input ?? {};
  if (tool === 'grep' || tool === 'websearch' || tool === 'codesearch') {
    return [{ type: 'search', ...input }];
  }
  if (tool === 'read') {
    return [{ type: 'read', ...input }];
  }
  if (tool === 'list' || tool === 'glob') {
    return [{ type: 'list_files', ...input }];
  }
  if (tool === 'edit' || tool === 'multiedit') {
    return [{ type: 'edit', ...input }];
  }
  if (tool === 'write') {
    return [{ type: 'write', ...input }];
  }
  if (tool === 'patch' || tool === 'apply_patch') {
    return [{ type: 'apply_patch', ...input }];
  }
  if (tool === 'bash') {
    return mapPermissionToParsedCmd('bash', typeof input.command === 'string' ? input.command : 'bash');
  }
  return [];
}

function shouldQuietOpenCodeTool(part: OpenCodeToolPart): boolean {
  const tool = part.tool.toLowerCase();
  return tool === 'grep'
    || tool === 'websearch'
    || tool === 'codesearch'
    || tool === 'read'
    || tool === 'list'
    || tool === 'glob';
}

function sanitizeOpenCodeAssistantText(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }
  const lines = normalized.split('\n');
  let index = 0;
  while (index < lines.length && !lines[index]?.trim()) {
    index += 1;
  }
  let droppedMeta = false;
  while (index < lines.length && isOpenCodeMetaLine(lines[index] ?? '')) {
    droppedMeta = true;
    index += 1;
    while (index < lines.length && !lines[index]?.trim()) {
      index += 1;
    }
  }
  if (!droppedMeta) {
    return normalized;
  }
  if (index >= lines.length) {
    return '';
  }
  return lines.slice(index).join('\n').trim();
}

function isOpenCodeMetaLine(value: string): boolean {
  const line = value.trim();
  if (!line) {
    return false;
  }
  return /^(the user\b|user\b|i should\b|i need to\b|need to\b|let me\b|we need to\b|we should\b|first[,:\s]|thinking\b|analysis\b)/i.test(line)
    || /as per my instructions/i.test(line);
}

function normalizeApprovalDecision(result: unknown): 'once' | 'always' | 'reject' {
  const decision = typeof result === 'object' && result && 'decision' in result
    ? String((result as { decision?: unknown }).decision ?? '')
    : '';
  if (decision === 'acceptForSession') {
    return 'always';
  }
  if (decision === 'accept') {
    return 'once';
  }
  return 'reject';
}

function extractOpenCodeErrorText(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const data = 'data' in error && error.data && typeof error.data === 'object'
    ? error.data as Record<string, unknown>
    : null;
  const directMessage = data?.message;
  if (typeof directMessage === 'string' && directMessage.trim()) {
    return directMessage;
  }
  const name = 'name' in error ? String((error as { name?: unknown }).name ?? '') : '';
  return name.trim() || null;
}

function isNotFound(error: unknown): boolean {
  return error instanceof OpenCodeApiError && error.statusCode === 404;
}

function isOpenCodeTextPart(part: OpenCodePart): part is Extract<OpenCodePart, { type: 'text' }> {
  return part.type === 'text' && typeof (part as { text?: unknown }).text === 'string';
}

function isOpenCodeReasoningPart(part: OpenCodePart): part is Extract<OpenCodePart, { type: 'reasoning' }> {
  return part.type === 'reasoning' && typeof (part as { text?: unknown }).text === 'string';
}

function isOpenCodeToolPart(part: OpenCodePart): part is OpenCodeToolPart {
  return part.type === 'tool'
    && typeof (part as { callID?: unknown }).callID === 'string'
    && typeof (part as { tool?: unknown }).tool === 'string'
    && typeof (part as { state?: unknown }).state === 'object'
    && part !== null;
}

function isOpenCodeCompletedPart(part: OpenCodePart): boolean {
  const time = (part as { time?: { end?: unknown } }).time;
  return typeof time?.end === 'number' && Number.isFinite(time.end);
}

function extractOpenCodePartMessageId(part: OpenCodePart): string | null {
  const messageId = (part as { messageID?: unknown }).messageID;
  return typeof messageId === 'string' && messageId ? messageId : null;
}

function compareTurnIds(messages: OpenCodeMessageEntry[], leftId: string, rightId: string): number {
  const order = new Map(messages.map((entry, index) => [entry.info.id, index]));
  return (order.get(leftId) ?? 0) - (order.get(rightId) ?? 0);
}
