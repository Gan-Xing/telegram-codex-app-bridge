import { EventEmitter } from 'node:events';
import type { AppConfig, CodexProviderProfileConfig } from '../config.js';
import { CodexAppClient } from '../codex_app/client.js';
import type { Logger } from '../logger.js';
import type {
  AccountIdentitySnapshot,
  AccountRateLimitSnapshot,
  AppThread,
  AppThreadWithTurns,
  ModelInfo,
  ThreadSessionState,
} from '../types.js';
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

interface ProfileRuntime {
  profile: CodexProviderProfileConfig;
  client: CodexAppClient;
}

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

  private readonly profiles = new Map<string, ProfileRuntime>();
  private readonly connectedProfiles = new Set<string>();
  private userAgent: string | null = null;

  constructor(
    profiles: CodexProviderProfileConfig[],
    private defaultProfileId: string,
    private readonly resolveProfileIdForScope: (scopeId?: string | null) => string,
    private readonly launchCommand: string,
    private readonly autolaunch: boolean,
    private readonly logger: Logger,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    super();
    for (const profile of profiles) {
      this.profiles.set(profile.id, {
        profile,
        client: this.createClient(profile),
      });
    }
    if (!this.profiles.has(this.defaultProfileId) && profiles[0]) {
      this.defaultProfileId = profiles[0].id;
    }
  }

  on(event: 'notification', listener: (message: EngineNotification) => void): this;
  on(event: 'serverRequest', listener: (message: EngineServerRequest) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  async start(): Promise<void> {
    await this.ensureStarted(this.defaultProfileId, this.getClient(this.defaultProfileId));
  }

  async stop(): Promise<void> {
    this.connectedProfiles.clear();
    this.userAgent = null;
    await Promise.all([...this.profiles.values()].map(async ({ client }) => client.stop()));
  }

  isConnected(): boolean {
    return this.connectedProfiles.size > 0;
  }

  getUserAgent(): string | null {
    const defaultClient = this.profiles.get(this.defaultProfileId)?.client ?? null;
    if (defaultClient?.getUserAgent()) {
      return defaultClient.getUserAgent();
    }
    for (const { client } of this.profiles.values()) {
      const userAgent = client.getUserAgent();
      if (userAgent) {
        return userAgent;
      }
    }
    return this.userAgent;
  }

  getAccountIdentity(): AccountIdentitySnapshot | null {
    return this.getClient(this.defaultProfileId).getAccountIdentity();
  }

  readAccountIdentity(): Promise<AccountIdentitySnapshot | null> {
    return this.getClient(this.defaultProfileId).readAccountIdentity();
  }

  getAccountRateLimits(): AccountRateLimitSnapshot | null {
    return this.getClient(this.defaultProfileId).getAccountRateLimits();
  }

  readAccountRateLimits(): Promise<AccountRateLimitSnapshot | null> {
    return this.getClient(this.defaultProfileId).readAccountRateLimits();
  }

  async listThreads(options: ListThreadsOptions): Promise<AppThread[]> {
    const client = await this.ensureProfileClient(this.resolveProfileId(options.scopeId));
    return client.listThreads({
      limit: options.limit,
      searchTerm: options.searchTerm ?? null,
      archived: options.archived ?? false,
    });
  }

  async readThread(threadId: string, includeTurns = false, scopeId?: string | null): Promise<AppThread | null> {
    const client = await this.ensureProfileClient(this.resolveProfileId(scopeId));
    return client.readThread(threadId, includeTurns);
  }

  async readThreadWithTurns(threadId: string, scopeId?: string | null): Promise<AppThreadWithTurns | null> {
    const client = await this.ensureProfileClient(this.resolveProfileId(scopeId));
    return client.readThreadWithTurns(threadId);
  }

  async renameThread(threadId: string, name: string, scopeId?: string | null): Promise<void> {
    const client = await this.ensureProfileClient(this.resolveProfileId(scopeId));
    await client.renameThread(threadId, name);
  }

  async archiveThread(threadId: string, scopeId?: string | null): Promise<void> {
    const client = await this.ensureProfileClient(this.resolveProfileId(scopeId));
    await client.archiveThread(threadId);
  }

  async unarchiveThread(threadId: string, scopeId?: string | null): Promise<void> {
    const client = await this.ensureProfileClient(this.resolveProfileId(scopeId));
    await client.unarchiveThread(threadId);
  }

  async startThread(options: StartThreadOptions): Promise<ThreadSessionState> {
    const profileId = this.resolveProfileId(options.scopeId);
    const client = await this.ensureProfileClient(profileId);
    const runtime = this.getRuntime(profileId)!;
    return client.startThread({
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      sandboxMode: options.sandboxMode,
      model: options.model ?? runtime.profile.defaultModel,
      serviceTier: options.serviceTier,
    });
  }

  async resumeThread(options: ResumeThreadOptions): Promise<ThreadSessionState> {
    const client = await this.ensureProfileClient(this.resolveProfileId(options.scopeId));
    return client.resumeThread({ threadId: options.threadId });
  }

  async revealThread(threadId: string, scopeId?: string | null): Promise<void> {
    const client = await this.ensureProfileClient(this.resolveProfileId(scopeId));
    await client.revealThread(threadId);
  }

  async startTurn(options: StartTurnOptions): Promise<TurnStartResult> {
    const profileId = this.resolveProfileId(options.scopeId);
    const client = await this.ensureProfileClient(profileId);
    const runtime = this.getRuntime(profileId)!;
    const request: StartTurnOptions = {
      threadId: options.threadId,
      input: options.input,
      approvalPolicy: options.approvalPolicy,
      sandboxMode: options.sandboxMode,
      cwd: options.cwd,
      model: options.model ?? runtime.profile.defaultModel,
      serviceTier: options.serviceTier,
      effort: options.effort,
      modelVariant: options.modelVariant ?? null,
      collaborationMode: options.collaborationMode,
      geminiApprovalMode: options.geminiApprovalMode ?? null,
      developerInstructions: options.developerInstructions,
      scopeId: options.scopeId ?? null,
    };
    return client.startTurn(request);
  }

  async steerTurn(options: SteerTurnOptions): Promise<TurnSteerResult> {
    const client = await this.ensureProfileClient(this.resolveProfileId(options.scopeId));
    return client.steerTurn(options);
  }

  async interruptTurn(threadId: string, turnId: string, scopeId?: string | null): Promise<void> {
    const client = await this.ensureProfileClient(this.resolveProfileId(scopeId));
    await client.interruptTurn(threadId, turnId);
  }

  async respond(requestId: string | number, result: unknown, scopeId?: string | null): Promise<void> {
    const client = await this.ensureProfileClient(this.resolveProfileId(scopeId));
    await client.respond(requestId, result);
  }

  async respondError(requestId: string | number, message: string, scopeId?: string | null): Promise<void> {
    const client = await this.ensureProfileClient(this.resolveProfileId(scopeId));
    await client.respondError(requestId, message);
  }

  async listModels(scopeId?: string | null): Promise<ModelInfo[]> {
    const client = await this.ensureProfileClient(this.resolveProfileId(scopeId));
    return client.listModels();
  }

  private resolveProfileId(scopeId?: string | null): string {
    const resolved = this.resolveProfileIdForScope(scopeId ?? null);
    return this.profiles.has(resolved) ? resolved : this.defaultProfileId;
  }

  private getClient(profileId: string): CodexAppClient {
    const client = this.getRuntime(profileId)?.client ?? this.profiles.values().next().value?.client ?? null;
    if (!client) {
      throw new Error('No Codex provider profiles configured');
    }
    return client;
  }

  private getRuntime(profileId: string): ProfileRuntime | null {
    return this.profiles.get(profileId) ?? null;
  }

  private async ensureProfileClient(profileId: string): Promise<CodexAppClient> {
    const client = this.getClient(profileId);
    await this.ensureStarted(profileId, client);
    return client;
  }

  private async ensureStarted(profileId: string, client: CodexAppClient): Promise<void> {
    if (client.isConnected()) {
      return;
    }
    await client.start();
  }

  private createClient(profile: CodexProviderProfileConfig): CodexAppClient {
    const client = new CodexAppClient(
      profile.cliBin,
      this.launchCommand,
      this.autolaunch,
      this.logger,
      this.platform,
      profile.modelCatalog,
      profile.modelCatalogMode ?? 'merge',
    );
    client.on('notification', (message: EngineNotification) => {
      this.emit('notification', message);
    });
    client.on('serverRequest', (message: EngineServerRequest) => {
      this.emit('serverRequest', message);
    });
    client.on('connected', () => {
      this.connectedProfiles.add(profile.id);
      this.userAgent = client.getUserAgent() ?? this.userAgent;
      if (this.connectedProfiles.size === 1) {
        this.emit('connected');
      }
    });
    client.on('disconnected', () => {
      this.emit('notification', {
        method: 'bridge/profile_disconnected',
        params: { profileId: profile.id },
      });
      const hadProfile = this.connectedProfiles.delete(profile.id);
      if (hadProfile && this.connectedProfiles.size === 0) {
        this.emit('disconnected');
      }
    });
    return client;
  }
}

export function createCodexEngineProvider(
  config: Pick<
    AppConfig,
    'codexProviderProfiles' | 'codexDefaultProviderProfileId' | 'codexAppLaunchCmd' | 'codexAppAutolaunch' | 'platform'
  >,
  logger: Logger,
  resolveProfileIdForScope: (scopeId?: string | null) => string,
): CodexEngineProvider {
  return new CodexEngineProvider(
    config.codexProviderProfiles,
    config.codexDefaultProviderProfileId,
    resolveProfileIdForScope,
    config.codexAppLaunchCmd,
    config.codexAppAutolaunch,
    logger,
    config.platform?.os,
  );
}
