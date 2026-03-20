import { EventEmitter } from 'node:events';
import type { AppConfig } from '../config.js';
import { CodexAppClient } from '../codex_app/client.js';
import type { Logger } from '../logger.js';
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
} from './types.js';

export class CodexEngineProvider extends EventEmitter implements EngineProvider {
  readonly engine = 'codex' as const;
  readonly capabilities = {
    threads: true,
    reveal: true,
    guidedPlan: 'full',
    approvals: 'full',
    steerActiveTurn: true,
    rateLimits: true,
    reasoningEffort: true,
    serviceTier: true,
    reconnect: true,
  } as const;

  constructor(private readonly client: CodexAppClient) {
    super();
    this.client.on('notification', (message: EngineNotification) => {
      this.emit('notification', message);
    });
    this.client.on('serverRequest', (message: EngineServerRequest) => {
      this.emit('serverRequest', message);
    });
    this.client.on('connected', () => {
      this.emit('connected');
    });
    this.client.on('disconnected', () => {
      this.emit('disconnected');
    });
  }

  start(): Promise<void> {
    return this.client.start();
  }

  stop(): Promise<void> {
    return this.client.stop();
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  getUserAgent(): string | null {
    return this.client.getUserAgent();
  }

  getAccountIdentity() {
    return this.client.getAccountIdentity();
  }

  readAccountIdentity() {
    return this.client.readAccountIdentity();
  }

  getAccountRateLimits() {
    return this.client.getAccountRateLimits();
  }

  readAccountRateLimits() {
    return this.client.readAccountRateLimits();
  }

  listThreads(options: ListThreadsOptions) {
    return this.client.listThreads(options);
  }

  readThread(threadId: string, includeTurns = false) {
    return this.client.readThread(threadId, includeTurns);
  }

  readThreadWithTurns(threadId: string) {
    return this.client.readThreadWithTurns(threadId);
  }

  renameThread(threadId: string, name: string): Promise<void> {
    return this.client.renameThread(threadId, name);
  }

  startThread(options: StartThreadOptions) {
    return this.client.startThread(options);
  }

  resumeThread(options: ResumeThreadOptions) {
    return this.client.resumeThread(options);
  }

  revealThread(threadId: string): Promise<void> {
    return this.client.revealThread(threadId);
  }

  startTurn(options: StartTurnOptions): Promise<TurnStartResult> {
    return this.client.startTurn(options);
  }

  steerTurn(options: SteerTurnOptions): Promise<TurnSteerResult> {
    return this.client.steerTurn(options);
  }

  interruptTurn(threadId: string, turnId: string): Promise<void> {
    return this.client.interruptTurn(threadId, turnId);
  }

  respond(requestId: string | number, result: unknown): Promise<void> {
    return this.client.respond(requestId, result);
  }

  respondError(requestId: string | number, message: string): Promise<void> {
    return this.client.respondError(requestId, message);
  }

  listModels() {
    return this.client.listModels();
  }
}

export function createCodexEngineProvider(
  config: Pick<AppConfig, 'codexCliBin' | 'codexAppLaunchCmd' | 'codexAppAutolaunch'>,
  logger: Logger,
): CodexEngineProvider {
  return new CodexEngineProvider(
    new CodexAppClient(
      config.codexCliBin,
      config.codexAppLaunchCmd,
      config.codexAppAutolaunch,
      logger,
    ),
  );
}
