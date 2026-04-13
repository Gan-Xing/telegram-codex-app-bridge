import { EventEmitter } from 'node:events';
import type { ChildProcessByStdio } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { spawnCommand } from '../process/spawn_command.js';

type RequestMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface OpenCodeSession {
  id: string;
  slug: string;
  directory: string;
  title: string;
  permission?: OpenCodePermissionRule[] | null;
  time: {
    created: number;
    updated: number;
    archived?: number;
  };
}

export interface OpenCodeSessionStatus {
  type: 'idle' | 'retry' | 'busy';
  attempt?: number;
  message?: string;
  next?: number;
}

export interface OpenCodePermissionRule {
  permission: string;
  pattern: string;
  action: 'allow' | 'deny' | 'ask';
}

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: {
    created: number;
    completed?: number;
  };
  parentID?: string;
  providerID?: string;
  modelID?: string;
  agent?: string;
  path?: {
    cwd: string;
    root: string;
  };
  error?: {
    name?: string;
    data?: Record<string, unknown>;
  };
}

export interface OpenCodeTextPart {
  id: string;
  type: 'text';
  text: string;
}

export interface OpenCodeReasoningPart {
  id: string;
  type: 'reasoning';
  text: string;
}

export interface OpenCodeToolPart {
  id: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: {
    status: 'pending' | 'running' | 'completed' | 'error';
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export interface OpenCodeFilePart {
  id: string;
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
}

export interface OpenCodeOtherPart {
  id: string;
  type: string;
  [key: string]: unknown;
}

export type OpenCodePart =
  | OpenCodeTextPart
  | OpenCodeReasoningPart
  | OpenCodeToolPart
  | OpenCodeFilePart
  | OpenCodeOtherPart;

export interface OpenCodeMessageEntry {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export interface OpenCodeQuestionOption {
  label: string;
  description: string;
}

export interface OpenCodeQuestionInfo {
  question: string;
  header: string;
  options: OpenCodeQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface OpenCodeQuestionRequest {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestionInfo[];
  tool?: {
    messageID: string;
    callID: string;
  };
}

export interface OpenCodePermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
}

export interface OpenCodeProviderModel {
  id: string;
  name: string;
  providerID: string;
  capabilities: {
    reasoning: boolean;
  };
  variants?: Record<string, Record<string, unknown>>;
}

export interface OpenCodeProviderCatalog {
  providers: Array<{
    id: string;
    name: string;
    models: Record<string, OpenCodeProviderModel>;
  }>;
  default: Record<string, string>;
}

export interface OpenCodeGlobalEvent {
  directory: string;
  project?: string;
  workspace?: string;
  payload: {
    type: string;
    properties: any;
  };
}

type OpenCodeClientConfig = Pick<
  AppConfig,
  'opencodeCliBin' | 'opencodeServerHostname' | 'opencodeServerPort' | 'defaultCwd'
>;

interface RequestOptions {
  query?: Record<string, string | number | null | undefined>;
  body?: unknown;
}

export class OpenCodeApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null,
    readonly payload: unknown = null,
  ) {
    super(message);
    this.name = 'OpenCodeApiError';
  }
}

export class OpenCodeClient extends EventEmitter {
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private baseUrl: string | null = null;
  private connected = false;
  private userAgent: string | null = null;
  private streamAbortController: AbortController | null = null;
  private stopping = false;
  private sseLoopPromise: Promise<void> | null = null;
  private readonly recentLogs: string[] = [];
  private authHeader: string | null = null;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: OpenCodeClientConfig,
    private readonly logger: Logger,
  ) {
    super();
    this.authHeader = buildOpenCodeBasicAuthHeader();
  }

  on(event: 'event', listener: (event: OpenCodeGlobalEvent) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  async start(): Promise<void> {
    if (this.process || this.connected) {
      return;
    }
    this.stopping = false;
    const hostname = this.config.opencodeServerHostname ?? '127.0.0.1';
    const port = this.config.opencodeServerPort ?? await findAvailablePort(hostname);
    const args = ['serve', '--hostname', hostname, '--port', String(port)];
    const command = this.config.opencodeCliBin ?? 'opencode';
    this.process = spawnCommand(command, args, {
      cwd: this.config.defaultCwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.baseUrl = `http://${hostname}:${port}`;
    this.userAgent = `${command} serve`;
    this.attachProcessLogging(this.process.stdout, 'stdout');
    this.attachProcessLogging(this.process.stderr, 'stderr');
    this.process.once('exit', (code, signal) => {
      this.logger.info('opencode.process.exit', { code, signal });
      this.process = null;
      if (!this.stopping) {
        this.markDisconnected();
        this.scheduleRestart('process_exit');
      }
    });
    await this.waitForHealth();
    this.connected = true;
    this.emit('connected');
    this.sseLoopPromise = this.runEventStreamLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.streamAbortController?.abort();
    this.streamAbortController = null;
    const processRef = this.process;
    this.process = null;
    if (processRef) {
      processRef.kill('SIGTERM');
      await waitForProcessExit(processRef, 5_000).catch(() => {
        processRef.kill('SIGKILL');
      });
    }
    await this.sseLoopPromise?.catch(() => undefined);
    this.sseLoopPromise = null;
    this.markDisconnected();
  }

  isConnected(): boolean {
    return this.connected;
  }

  getUserAgent(): string | null {
    return this.userAgent ?? this.config.opencodeCliBin ?? 'opencode';
  }

  async listSessions(directory: string): Promise<OpenCodeSession[]> {
    return this.requestJson('GET', '/session', {
      query: { directory },
    });
  }

  async getSessionStatuses(): Promise<Record<string, OpenCodeSessionStatus>> {
    return this.requestJson('GET', '/session/status');
  }

  async getSession(sessionID: string, directory?: string | null): Promise<OpenCodeSession> {
    return this.requestJson('GET', `/session/${encodeURIComponent(sessionID)}`, {
      query: { directory },
    });
  }

  async createSession(
    directory: string,
    title?: string | null,
    permission?: OpenCodePermissionRule[] | null,
    parentID?: string | null,
  ): Promise<OpenCodeSession> {
    const body: Record<string, unknown> = {};
    if (title?.trim()) {
      body.title = title.trim();
    }
    if (permission && permission.length > 0) {
      body.permission = permission;
    }
    if (parentID?.trim()) {
      body.parentID = parentID.trim();
    }
    return this.requestJson('POST', '/session', {
      query: { directory },
      body,
    });
  }

  async updateSession(
    sessionID: string,
    body: {
      title?: string;
      permission?: OpenCodePermissionRule[];
      time?: { archived?: number };
    },
    directory?: string | null,
  ): Promise<OpenCodeSession> {
    return this.requestJson('PATCH', `/session/${encodeURIComponent(sessionID)}`, {
      query: { directory },
      body,
    });
  }

  async getSessionMessages(
    sessionID: string,
    options: { limit?: number; directory?: string | null; before?: string | null } = {},
  ): Promise<OpenCodeMessageEntry[]> {
    return this.requestJson('GET', `/session/${encodeURIComponent(sessionID)}/message`, {
      query: {
        directory: options.directory,
        limit: options.limit,
        before: options.before,
      },
    });
  }

  async promptAsync(
    sessionID: string,
    body: {
      model?: { providerID: string; modelID: string };
      agent?: string;
      system?: string | null;
      variant?: string | null;
      parts: Array<Record<string, unknown>>;
    },
    directory?: string | null,
  ): Promise<void> {
    await this.requestJson('POST', `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      query: { directory },
      body,
    });
  }

  async abortSession(sessionID: string, directory?: string | null): Promise<void> {
    await this.requestJson('POST', `/session/${encodeURIComponent(sessionID)}/abort`, {
      query: { directory },
      body: {},
    });
  }

  async listProviders(): Promise<OpenCodeProviderCatalog> {
    return this.requestJson('GET', '/config/providers');
  }

  async listQuestions(): Promise<OpenCodeQuestionRequest[]> {
    return this.requestJson('GET', '/question');
  }

  async replyQuestion(requestID: string, answers: string[][]): Promise<void> {
    await this.requestJson('POST', `/question/${encodeURIComponent(requestID)}/reply`, {
      body: { answers },
    });
  }

  async rejectQuestion(requestID: string): Promise<void> {
    await this.requestJson('POST', `/question/${encodeURIComponent(requestID)}/reject`, {
      body: {},
    });
  }

  async replyPermission(
    sessionID: string,
    permissionID: string,
    response: 'once' | 'always' | 'reject',
    directory?: string | null,
  ): Promise<void> {
    await this.requestJson('POST', `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`, {
      query: { directory },
      body: { response },
    });
  }

  private async runEventStreamLoop(): Promise<void> {
    while (!this.stopping && this.baseUrl) {
      const controller = new AbortController();
      this.streamAbortController = controller;
      try {
        const response = await fetch(`${this.baseUrl}/global/event`, {
          method: 'GET',
          signal: controller.signal,
          headers: this.buildHeaders(),
        });
        if (!response.ok || !response.body) {
          throw new OpenCodeApiError(`OpenCode SSE failed: ${response.status} ${response.statusText}`, response.status);
        }
        await consumeSse(response.body, (rawEvent) => {
          if (!rawEvent) {
            return;
          }
          this.emit('event', rawEvent as OpenCodeGlobalEvent);
        }, controller.signal);
      } catch (error) {
        if (this.stopping || controller.signal.aborted) {
          return;
        }
        if (!this.process) {
          this.markDisconnected();
          this.logger.warn('opencode.sse.disconnected', { error: String(error) });
          this.scheduleRestart('sse_disconnected');
          return;
        }
        this.logger.warn('opencode.sse.disconnected', { error: String(error) });
        await delay(1_000);
      } finally {
        if (this.streamAbortController === controller) {
          this.streamAbortController = null;
        }
      }
    }
  }

  private async waitForHealth(): Promise<void> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      throw new Error('OpenCode base URL is unavailable');
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20_000) {
      if (!this.process) {
        break;
      }
      try {
        const response = await fetch(`${baseUrl}/global/health`, {
          method: 'GET',
          headers: this.buildHeaders(),
        });
        if (response.ok) {
          return;
        }
      } catch {
        // wait for server boot
      }
      await delay(200);
    }
    throw new Error(`OpenCode server did not become healthy. Recent logs: ${this.recentLogs.slice(-6).join(' | ')}`);
  }

  private async requestJson<T>(method: RequestMethod, pathname: string, options: RequestOptions = {}): Promise<T> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      throw new Error('OpenCode server is not started');
    }
    const url = new URL(pathname, baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === null || value === undefined || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.buildHeaders(options.body !== undefined),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      if (!this.stopping && !this.process) {
        this.markDisconnected();
        this.scheduleRestart('request_failed');
      }
      throw error;
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    const payload = text ? parseJsonSafely(text) : null;
    if (!response.ok) {
      const message = typeof payload === 'object' && payload && 'name' in payload
        ? String((payload as any).name)
        : response.statusText || `HTTP ${response.status}`;
      throw new OpenCodeApiError(message, response.status, payload ?? text);
    }
    return payload as T;
  }

  private attachProcessLogging(stream: Readable | null, source: 'stdout' | 'stderr'): void {
    if (!stream) {
      return;
    }
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = normalized.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        this.rememberLog(trimmed);
        this.logger.debug(`opencode.${source}`, { line: trimmed });
      }
    });
  }

  private rememberLog(line: string): void {
    this.recentLogs.push(line);
    if (this.recentLogs.length > 40) {
      this.recentLogs.shift();
    }
  }

  private buildHeaders(includeJson = false): Headers {
    const headers = new Headers();
    if (includeJson) {
      headers.set('content-type', 'application/json');
    }
    if (this.authHeader) {
      headers.set('authorization', this.authHeader);
    }
    return headers;
  }

  private markDisconnected(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.emit('disconnected');
  }

  private scheduleRestart(reason: 'process_exit' | 'sse_disconnected' | 'request_failed'): void {
    if (this.stopping || this.process || this.restartTimer) {
      return;
    }
    this.logger.warn('opencode.restart_scheduled', { reason });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.process || this.connected) {
        return;
      }
      void this.start().catch((error) => {
        this.logger.warn('opencode.restart_failed', { reason, error: String(error) });
        this.scheduleRestart('process_exit');
      });
    }, 1_000);
  }
}

async function findAvailablePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate OpenCode port')));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abortHandler = () => {
    void reader.cancel();
  };
  signal.addEventListener('abort', abortHandler);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const lines = chunk.split('\n');
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('data:')) {
            dataLines.push(line.replace(/^data:\s*/, ''));
          }
        }
        if (dataLines.length === 0) {
          continue;
        }
        onEvent(parseJsonSafely(dataLines.join('\n')));
      }
    }
  } finally {
    signal.removeEventListener('abort', abortHandler);
    buffer += decoder.decode();
    reader.releaseLock();
  }
}

function parseJsonSafely(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildOpenCodeBasicAuthHeader(): string | null {
  const password = process.env.OPENCODE_SERVER_PASSWORD?.trim();
  if (!password) {
    return null;
  }
  const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode';
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function waitForProcessExit(
  processRef: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => {
      processRef.once('exit', () => resolve());
    }),
    delay(timeoutMs).then(() => {
      throw new Error('Timed out waiting for process exit');
    }),
  ]);
}
