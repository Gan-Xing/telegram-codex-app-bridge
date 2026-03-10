import { EventEmitter } from 'node:events';
import net from 'node:net';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Logger } from '../logger.js';
import type {
  AccountRateLimitSnapshot,
  AppThread,
  CollaborationModeValue,
  CreditsSnapshot,
  ModelInfo,
  RateLimitWindow,
  ReasoningEffortValue,
  SandboxModeValue,
  ThreadSessionState,
  ThreadStatusKind,
} from '../types.js';
import { getDesktopOpenSupport } from '../platform/capabilities.js';
import { buildThreadDeepLink, openUrl } from './deeplink.js';

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params?: any;
}

export interface JsonRpcServerRequest {
  id: string | number;
  method: string;
  params?: any;
}

interface ListThreadsOptions {
  limit: number;
  searchTerm?: string | null;
}

interface StartThreadOptions {
  cwd: string | null;
  approvalPolicy: string;
  sandboxMode: SandboxModeValue;
  model: string | null;
}

interface ResumeThreadOptions {
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

interface StartTurnOptions {
  threadId: string;
  input: TurnInput[];
  approvalPolicy: string;
  sandboxMode: SandboxModeValue;
  cwd: string | null;
  model: string | null;
  effort: ReasoningEffortValue | null;
  collaborationMode: CollaborationModeValue | null;
  developerInstructions: string | null;
}

export const PLAN_MODE_DEVELOPER_INSTRUCTIONS = [
  'When you need user input in plan mode, ask one concrete decision at a time.',
  'Prefer requestUserInput questions with 2-3 mutually exclusive options.',
  'Put the recommended option first.',
  'Keep option labels concise and descriptions short and user-facing.',
  'Use isOther only when a custom answer would materially help.',
].join('\n');

export class CodexAppClient extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private socket: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  private desiredRunning = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private port: number | null = null;
  private connected = false;
  private userAgent: string | null = null;
  private accountRateLimits: AccountRateLimitSnapshot | null = null;

  constructor(
    private readonly codexCliBin: string,
    private readonly launchCommand: string,
    private readonly autolaunch: boolean,
    private readonly logger: Logger,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    super();
  }

  isConnected(): boolean {
    return this.connected;
  }

  getUserAgent(): string | null {
    return this.userAgent;
  }

  getAccountRateLimits(): AccountRateLimitSnapshot | null {
    return this.accountRateLimits;
  }

  async start(): Promise<void> {
    this.desiredRunning = true;
    if (this.connected) return;
    await this.startServer();
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.child?.kill('SIGTERM');
    this.rejectPending(new Error('Codex app bridge stopped'));
    this.socket = null;
    this.child = null;
    this.connected = false;
  }

  async listThreads(options: ListThreadsOptions): Promise<AppThread[]> {
    const result = await this.request('thread/list', {
      limit: options.limit,
      sortKey: 'updated_at',
      searchTerm: options.searchTerm ?? null,
      archived: false,
    });
    const rows = Array.isArray((result as any).data) ? (result as any).data : [];
    return rows.map(mapThread);
  }

  async readThread(threadId: string, includeTurns = false): Promise<AppThread | null> {
    const result = await this.request('thread/read', { threadId, includeTurns });
    const thread = (result as any).thread;
    return thread ? mapThread(thread) : null;
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.request('thread/name/set', { threadId, name });
  }

  async startThread(options: StartThreadOptions): Promise<ThreadSessionState> {
    const result = await this.request('thread/start', {
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      model: options.model,
      modelProvider: null,
      sandbox: options.sandboxMode,
      config: null,
      serviceName: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ephemeral: null,
      experimentalRawEvents: true,
      persistExtendedHistory: false,
    });
    return mapThreadSessionState(result);
  }

  async resumeThread(options: ResumeThreadOptions): Promise<ThreadSessionState> {
    const result = await this.request('thread/resume', {
      threadId: options.threadId,
      cwd: null,
      approvalPolicy: null,
      baseInstructions: null,
      developerInstructions: null,
      config: null,
      sandbox: null,
      model: null,
      modelProvider: null,
      personality: null,
      experimentalRawEvents: true,
      persistExtendedHistory: false,
    });
    return mapThreadSessionState(result);
  }

  async startTurn(options: StartTurnOptions): Promise<{ id: string; status: string }> {
    const result = await this.request('turn/start', {
      threadId: options.threadId,
      input: options.input,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      sandboxPolicy: mapSandboxPolicy(options.sandboxMode),
      model: options.model,
      effort: options.effort,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: options.collaborationMode === 'plan'
        ? {
            mode: 'plan',
            settings: {
              model: options.model,
              reasoning_effort: options.effort,
              developer_instructions: options.developerInstructions ?? PLAN_MODE_DEVELOPER_INSTRUCTIONS,
            },
          }
        : null,
    });
    return (result as any).turn;
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request('model/list', { cursor, limit: 100, includeHidden: false });
      const rows = Array.isArray((result as any).data) ? (result as any).data : [];
      models.push(...rows.map(mapModel));
      cursor = typeof (result as any).nextCursor === 'string' ? (result as any).nextCursor : null;
    } while (cursor);
    return models;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  async readAccountRateLimits(): Promise<AccountRateLimitSnapshot | null> {
    const result = await this.request('account/rateLimits/read', undefined);
    const mapped = mapAccountRateLimitResponse(result);
    this.accountRateLimits = mapped;
    return mapped;
  }

  async revealThread(threadId: string): Promise<void> {
    const desktopOpen = getDesktopOpenSupport(this.platform);
    if (!desktopOpen.available) {
      throw new Error(desktopOpen.reason || 'desktop open is unavailable on this host');
    }
    const url = buildThreadDeepLink(threadId);
    await openUrl(url, this.platform);
  }

  async respond(requestId: string | number, result: unknown): Promise<void> {
    this.send({ jsonrpc: '2.0', id: requestId, result });
  }

  async respondError(requestId: string | number, message: string): Promise<void> {
    this.send({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message } });
  }

  private async startServer(): Promise<void> {
    if (this.autolaunch && this.launchCommand.trim()) {
      const launcher = spawn(this.launchCommand, { shell: true, detached: true, stdio: 'ignore' });
      launcher.unref();
    } else if (this.autolaunch) {
      this.logger.warn('codex.desktop_autolaunch_skipped', { reason: 'no launch command configured' });
    }
    this.port = await reservePort();
    this.child = spawn(this.codexCliBin, ['app-server', '--listen', `ws://127.0.0.1:${this.port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr?.on('data', chunk => {
      this.logger.debug('codex.app-server.stderr', chunk.toString().trim());
    });
    this.child.stdout?.on('data', chunk => {
      this.logger.debug('codex.app-server.stdout', chunk.toString().trim());
    });
    this.child.on('exit', (code, signal) => {
      this.child = null;
      this.handleDisconnect({ code, signal, source: 'process-exit' });
    });
    await this.connectWebSocket();
    await this.initialize();
  }

  private async connectWebSocket(): Promise<void> {
    const url = `ws://127.0.0.1:${this.port}`;
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(url);
          const onError = (event: Event) => {
            ws.close();
            reject(new Error(`WebSocket connect failed: ${String(event.type)}`));
          };
          ws.addEventListener('open', () => {
            this.socket = ws;
            this.connected = true;
            ws.addEventListener('message', message => this.handleMessage(String(message.data)));
            ws.addEventListener('close', () => {
              this.socket = null;
              this.handleDisconnect({ code: 'ws-close', source: 'websocket-close' });
            });
            ws.addEventListener('error', err => {
              this.logger.warn('codex.ws.error', String((err as ErrorEvent).message ?? 'unknown'));
            });
            resolve();
          }, { once: true });
          ws.addEventListener('error', onError, { once: true });
        });
        this.emit('connected');
        return;
      } catch {
        await sleep(250);
      }
    }
    throw new Error(`Timed out connecting to ${url}`);
  }

  private async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      clientInfo: {
        name: 'telegram-codex-app-bridge',
        title: 'Telegram Codex App Bridge',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'codex/event/agent_reasoning_delta',
          'codex/event/reasoning_content_delta',
          'codex/event/reasoning_raw_content_delta',
          'codex/event/exec_command_output_delta',
        ]
      }
    });
    this.userAgent = (result as any).userAgent ?? null;
    this.send({ jsonrpc: '2.0', method: 'initialized' });
    void this.readAccountRateLimits().catch((error) => {
      this.logger.warn('codex.account_rate_limits_read_failed', { error: String(error) });
    });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.socket || !this.connected) {
      await this.start();
    }
    const id = String(++this.requestId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('codex app-server socket is not open');
    }
    this.socket.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.logger.warn('codex.message.parse_failed', { raw, error: String(error) });
      return;
    }

    if ('id' in message && !('method' in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message || 'JSON-RPC error'));
      } else {
        pending.resolve((message as JsonRpcResponse).result);
      }
      return;
    }

    if ('id' in message && 'method' in message) {
      this.emit('serverRequest', message satisfies JsonRpcServerRequest);
      return;
    }

    if ('method' in message) {
      if (message.method === 'account/rateLimits/updated') {
        const params = message.params as any;
        this.accountRateLimits = mapRateLimitSnapshot(params?.rateLimits ?? null);
      }
      this.emit('notification', message satisfies JsonRpcNotification);
    }
  }

  private handleDisconnect(meta: Record<string, unknown>): void {
    if (this.connected) {
      this.connected = false;
    }
    this.accountRateLimits = null;
    this.rejectPending(new Error(`codex app-server disconnected: ${JSON.stringify(meta)}`));
    this.emit('disconnected', meta);
    if (this.desiredRunning) {
      this.scheduleReconnect();
    }
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.desiredRunning) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.startServer();
      } catch (error) {
        this.logger.error('codex.reconnect_failed', { error: String(error) });
        this.scheduleReconnect();
      }
    }, 1500);
  }
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve TCP port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mapThread(raw: any): AppThread {
  return {
    threadId: String(raw.id),
    name: raw.name ? String(raw.name) : null,
    preview: String(raw.preview || '(empty)'),
    cwd: raw.cwd ? String(raw.cwd) : null,
    modelProvider: raw.modelProvider ? String(raw.modelProvider) : null,
    status: mapThreadStatus(raw.status),
    updatedAt: Number(raw.updatedAt || 0),
  };
}

function mapThreadStatus(raw: any): ThreadStatusKind {
  const type = raw?.type;
  if (type === 'active' || type === 'idle' || type === 'notLoaded' || type === 'systemError') {
    return type;
  }
  return 'idle';
}

function mapThreadSessionState(raw: any): ThreadSessionState {
  return {
    thread: mapThread(raw.thread),
    model: String(raw.model),
    modelProvider: String(raw.modelProvider),
    reasoningEffort: raw.reasoningEffort === null ? null : String(raw.reasoningEffort) as ReasoningEffortValue,
    cwd: String(raw.cwd),
  };
}

function mapModel(raw: any): ModelInfo {
  const efforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
        .map((entry: any) => entry?.reasoningEffort)
        .filter((value: unknown): value is ReasoningEffortValue => typeof value === 'string')
    : [];
  return {
    id: String(raw.id),
    model: String(raw.model),
    displayName: String(raw.displayName || raw.model),
    description: String(raw.description || ''),
    isDefault: Boolean(raw.isDefault),
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: String(raw.defaultReasoningEffort) as ReasoningEffortValue,
  };
}

function mapSandboxPolicy(mode: SandboxModeValue): { type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess' } {
  if (mode === 'read-only') {
    return { type: 'readOnly' };
  }
  if (mode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }
  return { type: 'workspaceWrite' };
}

function mapAccountRateLimitResponse(raw: any): AccountRateLimitSnapshot | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const byLimitId = raw.rateLimitsByLimitId && typeof raw.rateLimitsByLimitId === 'object'
    ? raw.rateLimitsByLimitId as Record<string, unknown>
    : null;
  const codexRateLimit = byLimitId?.codex ?? raw.rateLimits ?? null;
  return mapRateLimitSnapshot(codexRateLimit);
}

function mapRateLimitSnapshot(raw: any): AccountRateLimitSnapshot | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return {
    limitId: raw.limitId === null || raw.limitId === undefined ? null : String(raw.limitId),
    limitName: raw.limitName === null || raw.limitName === undefined ? null : String(raw.limitName),
    primary: mapRateLimitWindow(raw.primary),
    secondary: mapRateLimitWindow(raw.secondary),
    credits: mapCreditsSnapshot(raw.credits),
    planType: raw.planType === null || raw.planType === undefined ? null : String(raw.planType),
  };
}

function mapRateLimitWindow(raw: any): RateLimitWindow | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return {
    usedPercent: Number.isFinite(Number(raw.usedPercent)) ? Number(raw.usedPercent) : 0,
    windowDurationMins: raw.windowDurationMins === null || raw.windowDurationMins === undefined
      ? null
      : Number(raw.windowDurationMins),
    resetsAt: raw.resetsAt === null || raw.resetsAt === undefined ? null : Number(raw.resetsAt),
  };
}

function mapCreditsSnapshot(raw: any): CreditsSnapshot | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return {
    hasCredits: Boolean(raw.hasCredits),
    unlimited: Boolean(raw.unlimited),
    balance: raw.balance === null || raw.balance === undefined ? null : String(raw.balance),
  };
}
