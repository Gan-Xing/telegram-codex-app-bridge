import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import {
  resolveCodexProfileReasoningEffortSupport,
  resolveCodexProfileServiceTierSupport,
  resolveCodexProviderProfile,
} from '../codex_profiles.js';
import { resolveEngineCapabilities, type EngineProvider, type TurnInput } from '../engine/types.js';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import {
  TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES,
  buildAttachmentPrompt,
  isNativeImageAttachment,
  planAttachmentStoragePath,
  type StagedTelegramAttachment,
  type TelegramInboundAttachment,
} from '../telegram/media.js';
import type { TelegramGateway, TelegramTextEvent } from '../telegram/gateway.js';
import type {
  AppLocale,
  CollaborationModeValue,
  GeminiApprovalModeValue,
  ReasoningEffortValue,
  SandboxModeValue,
  ServiceTierValue,
  ThreadBinding,
  ThreadSessionState,
} from '../types.js';
import { resolveAccessMode } from './access.js';
import type { ThreadAttachmentRegistry } from './bridge_runtime.js';
import type { ActiveTurn } from './turn_state.js';
import { formatUserError, isThreadNotFoundError } from './utils.js';
import { resolveCurrentModel } from './presentation.js';

export class UserFacingError extends Error {}

interface ThreadSessionHost {
  config: AppConfig;
  store: BridgeStore;
  logger: Logger;
  app: Pick<EngineProvider, 'capabilities' | 'listModels' | 'startThread' | 'startTurn' | 'resumeThread' | 'readThread' | 'revealThread'>;
  bot: Pick<TelegramGateway, 'getFile' | 'downloadResolvedFile'>;
  attachedThreads: ThreadAttachmentRegistry;
  localeForChat: (scopeId: string, languageCode?: string | null) => AppLocale;
  sendMessage: (scopeId: string, text: string) => Promise<number>;
  updateStatus: () => void;
}

interface StartTurnOptions {
  developerInstructions?: string | null;
  accessOverride?: { approvalPolicy: string; sandboxMode: SandboxModeValue };
  collaborationModeOverride?: CollaborationModeValue | null;
  geminiApprovalModeOverride?: GeminiApprovalModeValue | null;
}

export class ThreadSessionService {
  constructor(private readonly host: ThreadSessionHost) {}

  private get capabilities() {
    return resolveEngineCapabilities(this.host.app.capabilities);
  }

  private supportsReasoningEffort(scopeId: string): boolean {
    return resolveCodexProfileReasoningEffortSupport(
      resolveCodexProviderProfile(this.host.config, this.host.store.getActiveProviderProfile(scopeId)),
      this.capabilities.reasoningEffort,
    );
  }

  private supportsServiceTier(scopeId: string): boolean {
    return resolveCodexProfileServiceTierSupport(
      resolveCodexProviderProfile(this.host.config, this.host.store.getActiveProviderProfile(scopeId)),
      this.capabilities.serviceTier,
    );
  }

  async createBinding(scopeId: string, requestedCwd: string | null): Promise<ThreadBinding> {
    const cwd = requestedCwd || this.host.config.defaultCwd;
    const settings = this.host.store.getChatSettings(scopeId);
    const access = resolveAccessMode(this.host.config, settings);
    const session = await this.host.app.startThread({
      cwd,
      approvalPolicy: access.approvalPolicy,
      sandboxMode: access.sandboxMode,
      model: settings?.model ?? null,
      serviceTier: this.supportsServiceTier(scopeId) ? (settings?.serviceTier ?? null) : null,
      scopeId,
    });
    return this.storeThreadSession(scopeId, session, 'seed');
  }

  async startTurnWithRecovery(
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    input: TurnInput[],
    options: StartTurnOptions = {},
  ): Promise<{ threadId: string; turnId: string }> {
    const settings = this.host.store.getChatSettings(scopeId);
    const access = resolveAccessMode(this.host.config, settings);
    const turnConfig = await this.resolveTurnConfiguration(scopeId, settings, options.collaborationModeOverride);
    const effectiveAccess = options.accessOverride ?? access;
    try {
      return await this.startTurnOnBinding(scopeId, binding, input, effectiveAccess, turnConfig, options.developerInstructions ?? null);
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      const recovered = await this.recoverExistingThread(scopeId, binding, 'turn-start');
      if (recovered) {
        try {
          return await this.startTurnOnBinding(scopeId, recovered, input, effectiveAccess, turnConfig, options.developerInstructions ?? null);
        } catch (retryError) {
          if (!isThreadNotFoundError(retryError)) {
            throw retryError;
          }
          this.host.logger.warn('codex.turn_thread_retry_failed', { scopeId, threadId: binding.threadId });
        }
      }
      this.host.logger.warn('codex.turn_thread_not_found', { scopeId, threadId: binding.threadId });
      const replacement = await this.createBinding(scopeId, binding.cwd ?? this.host.config.defaultCwd);
      await this.host.sendMessage(
        scopeId,
        t(this.host.localeForChat(scopeId), 'current_thread_unavailable_continued', { threadId: replacement.threadId }),
      );
      const nextSettings = this.host.store.getChatSettings(scopeId);
      const nextAccess = resolveAccessMode(this.host.config, nextSettings);
      const nextTurnConfig = await this.resolveTurnConfiguration(scopeId, nextSettings, options.collaborationModeOverride);
      const fallbackAccess = options.accessOverride ?? nextAccess;
      return this.startTurnOnBinding(
        scopeId,
        replacement,
        input,
        fallbackAccess,
        nextTurnConfig,
        options.developerInstructions ?? null,
      );
    }
  }

  async buildTurnInput(
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    event: Pick<TelegramTextEvent, 'text' | 'attachments'>,
    locale: AppLocale,
  ): Promise<TurnInput[]> {
    if (event.attachments.length === 0) {
      return [{
        type: 'text',
        text: event.text,
        text_elements: [],
      }];
    }

    const stagedAttachments = await this.stageInboundAttachments(binding, event.attachments, locale);
    return this.buildTurnInputFromStagedAttachments(event.text, stagedAttachments);
  }

  async stageInboundAttachments(
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    attachments: readonly TelegramInboundAttachment[],
    locale: AppLocale,
  ): Promise<StagedTelegramAttachment[]> {
    const cwd = binding.cwd ?? this.host.config.defaultCwd;
    return this.stageAttachments(cwd, binding.threadId, attachments, locale);
  }

  buildTurnInputFromStagedAttachments(
    text: string,
    stagedAttachments: readonly StagedTelegramAttachment[],
  ): TurnInput[] {
    const prompt = buildAttachmentPrompt(text, stagedAttachments);
    const input: TurnInput[] = [{
      type: 'text',
      text: prompt,
      text_elements: [],
    }];
    for (const attachment of stagedAttachments) {
      if (!attachment.nativeImage) {
        continue;
      }
      input.push({
        type: 'localImage',
        path: attachment.localPath,
      });
    }
    return input;
  }

  resolveActiveTurnBinding(scopeId: string, active: Pick<ActiveTurn, 'threadId'>): ThreadBinding {
    const binding = this.host.store.getBinding(scopeId);
    if (binding?.threadId === active.threadId) {
      return binding;
    }
    return {
      chatId: scopeId,
      threadId: active.threadId,
      cwd: binding?.cwd ?? this.host.config.defaultCwd,
      updatedAt: Date.now(),
    };
  }

  async ensureThreadReady(scopeId: string, binding: ThreadBinding): Promise<ThreadBinding> {
    if (this.host.attachedThreads.has(binding.threadId)) {
      return binding;
    }
    try {
      return await this.resumeBinding(scopeId, binding);
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      const recovered = await this.recoverExistingThread(scopeId, binding, 'ensure-ready');
      if (recovered) {
        return recovered;
      }
      this.host.logger.warn('codex.thread_binding_stale', { scopeId, threadId: binding.threadId });
      const replacement = await this.createBinding(scopeId, binding.cwd ?? this.host.config.defaultCwd);
      await this.host.sendMessage(
        scopeId,
        t(this.host.localeForChat(scopeId), 'previous_thread_unavailable_started', { threadId: replacement.threadId }),
      );
      return {
        chatId: scopeId,
        threadId: replacement.threadId,
        cwd: replacement.cwd,
        updatedAt: Date.now(),
      };
    }
  }

  async tryRevealThread(
    scopeId: string,
    threadId: string,
    reason: 'open' | 'reveal' | 'turn-complete',
  ): Promise<string | null> {
    try {
      await this.host.app.revealThread(threadId, scopeId);
      this.host.store.insertAudit('outbound', scopeId, 'codex.app.reveal', `${reason}:${threadId}`);
      return null;
    } catch (error) {
      return formatUserError(error);
    }
  }

  async bindCachedThread(scopeId: string, threadId: string): Promise<ThreadBinding> {
    const session = await this.host.app.resumeThread({ threadId, scopeId });
    return this.storeThreadSession(scopeId, session, 'replace');
  }

  async resolvePlanSessionBinding(scopeId: string, threadId: string): Promise<ThreadBinding> {
    const existing = this.host.store.getBinding(scopeId);
    if (existing?.threadId === threadId) {
      return this.ensureThreadReady(scopeId, existing);
    }
    const thread = await this.host.app.readThread(threadId, false, scopeId);
    if (!thread) {
      throw new Error(`Thread ${threadId} is unavailable`);
    }
    const cwd = thread.cwd ?? this.host.config.defaultCwd;
    this.host.store.setBinding(scopeId, threadId, cwd);
    return {
      chatId: scopeId,
      threadId,
      cwd,
      updatedAt: Date.now(),
    };
  }

  handleSessionConfigured(scopeId: string, params: any): void {
    const binding = this.host.store.getBinding(scopeId);
    const cwd = params.cwd ? String(params.cwd) : binding?.cwd ?? null;
    this.host.store.setBinding(scopeId, String(params.session_id), cwd);
    const current = this.host.store.getChatSettings(scopeId);
    const preserveDefaultModel = current !== null && current.model === null;
    const preserveDefaultEffort = current !== null && current.reasoningEffort === null;
    const preserveDefaultServiceTier = current !== null && current.serviceTier === null;
    this.host.store.setChatSettings(
      scopeId,
      preserveDefaultModel
        ? null
        : params.model
          ? String(params.model)
          : current?.model ?? null,
      preserveDefaultEffort
        ? null
        : params.reasoning_effort === undefined
          ? current?.reasoningEffort ?? null
          : params.reasoning_effort === null
            ? null
            : String(params.reasoning_effort) as ReasoningEffortValue,
      undefined,
      current?.modelVariant ?? null,
    );
    this.host.store.setChatServiceTier(
      scopeId,
      preserveDefaultServiceTier
        ? null
        : params.service_tier === undefined && params.serviceTier === undefined
          ? current?.serviceTier ?? null
          : params.service_tier === null || params.serviceTier === null
            ? null
            : String(params.service_tier ?? params.serviceTier) as ServiceTierValue,
    );
    this.host.updateStatus();
  }

  private storeThreadSession(scopeId: string, session: ThreadSessionState, syncMode: 'replace' | 'seed'): ThreadBinding {
    const existing = this.host.store.getChatSettings(scopeId);
    const hasExisting = existing !== null;
    const model = syncMode === 'seed'
      ? hasExisting ? existing.model : session.model
      : session.model;
    const effort = syncMode === 'seed'
      ? hasExisting ? existing.reasoningEffort : session.reasoningEffort
      : session.reasoningEffort;
    const modelVariant = existing?.modelVariant ?? session.modelVariant ?? null;
    const serviceTier = syncMode === 'seed'
      ? hasExisting ? existing.serviceTier : session.serviceTier
      : session.serviceTier;
    const normalized: ThreadBinding = {
      chatId: scopeId,
      threadId: session.thread.threadId,
      cwd: session.cwd,
      updatedAt: Date.now(),
    };
    this.host.store.setBinding(scopeId, normalized.threadId, normalized.cwd);
    this.host.store.setChatSettings(scopeId, model, effort, undefined, modelVariant);
    this.host.store.setChatServiceTier(scopeId, serviceTier);
    this.host.attachedThreads.add(normalized.threadId);
    this.host.updateStatus();
    return normalized;
  }

  private async startTurnOnBinding(
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    input: TurnInput[],
    access: { approvalPolicy: string; sandboxMode: SandboxModeValue },
    turnConfig: {
      model: string | null;
      serviceTier: ServiceTierValue | null;
      effort: ReasoningEffortValue | null;
      modelVariant: string | null;
      collaborationMode: CollaborationModeValue | null;
      geminiApprovalMode: GeminiApprovalModeValue | null;
    },
    developerInstructions: string | null,
  ): Promise<{ threadId: string; turnId: string }> {
    const turn = await this.host.app.startTurn({
      threadId: binding.threadId,
      input,
      approvalPolicy: access.approvalPolicy,
      sandboxMode: access.sandboxMode,
      cwd: binding.cwd ?? this.host.config.defaultCwd,
      model: turnConfig.model,
      serviceTier: turnConfig.serviceTier,
      effort: turnConfig.effort,
      modelVariant: turnConfig.modelVariant,
      collaborationMode: turnConfig.collaborationMode,
      geminiApprovalMode: turnConfig.geminiApprovalMode,
      developerInstructions,
      scopeId,
    });
    const resolvedThreadId = turn.threadId ?? binding.threadId;
    if (resolvedThreadId !== binding.threadId) {
      const rebound = await this.bindCachedThread(scopeId, resolvedThreadId);
      return { threadId: rebound.threadId, turnId: turn.id };
    }
    return { threadId: binding.threadId, turnId: turn.id };
  }

  private async resumeBinding(
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
  ): Promise<ThreadBinding> {
    const session = await this.host.app.resumeThread({ threadId: binding.threadId, scopeId });
    return this.storeThreadSession(scopeId, session, 'seed');
  }

  private async recoverExistingThread(
    scopeId: string,
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    reason: 'ensure-ready' | 'turn-start',
  ): Promise<ThreadBinding | null> {
    let threadExists = false;
    try {
      threadExists = Boolean(await this.host.app.readThread(binding.threadId, false, scopeId));
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    if (!threadExists) {
      return null;
    }
    this.host.logger.warn('codex.thread_resume_retry', { scopeId, threadId: binding.threadId, reason });
    try {
      return await this.resumeBinding(scopeId, binding);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async resolveTurnConfiguration(
    scopeId: string,
    settings = this.host.store.getChatSettings(scopeId),
    collaborationModeOverride?: CollaborationModeValue | null,
    geminiApprovalModeOverride?: GeminiApprovalModeValue | null,
  ): Promise<{
    model: string | null;
    serviceTier: ServiceTierValue | null;
    effort: ReasoningEffortValue | null;
    modelVariant: string | null;
    collaborationMode: CollaborationModeValue | null;
    geminiApprovalMode: GeminiApprovalModeValue | null;
  }> {
    let model = settings?.model ?? null;
    const serviceTier = this.supportsServiceTier(scopeId) ? (settings?.serviceTier ?? null) : null;
    const effort = this.supportsReasoningEffort(scopeId) ? (settings?.reasoningEffort ?? null) : null;
    const modelVariant = settings?.modelVariant ?? null;
    const configuredCollaborationMode = this.capabilities.guidedPlan === 'none'
      ? null
      : collaborationModeOverride === undefined
      ? settings?.collaborationMode ?? null
      : collaborationModeOverride;
    const collaborationMode = this.host.config.bridgeEngine === 'codex' && this.capabilities.guidedPlan !== 'none'
      ? configuredCollaborationMode ?? 'default'
      : configuredCollaborationMode;
    const geminiApprovalMode = this.host.config.bridgeEngine !== 'gemini'
      ? null
      : geminiApprovalModeOverride === undefined
        ? settings?.geminiApprovalMode ?? null
        : geminiApprovalModeOverride;
    if (collaborationMode !== null && !model) {
      const models = await this.host.app.listModels(scopeId);
      model = resolveCurrentModel(models, null)?.model ?? null;
    }
    return { model, serviceTier, effort, modelVariant, collaborationMode, geminiApprovalMode };
  }

  private async stageAttachments(
    cwd: string,
    threadId: string,
    attachments: readonly TelegramInboundAttachment[],
    locale: AppLocale,
  ): Promise<StagedTelegramAttachment[]> {
    const staged: StagedTelegramAttachment[] = [];
    for (const attachment of attachments) {
      try {
        const remoteFile = await this.host.bot.getFile(attachment.fileId);
        const resolvedSize = attachment.fileSize ?? remoteFile.file_size ?? null;
        if (resolvedSize !== null && resolvedSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES) {
          throw new UserFacingError(t(locale, 'attachment_too_large', {
            name: attachment.fileName ?? attachment.fileUniqueId,
            size: resolvedSize,
          }));
        }
        if (!remoteFile.file_path) {
          throw new Error('Telegram file path is missing');
        }
        const planned = planAttachmentStoragePath(cwd, threadId, attachment, remoteFile.file_path);
        await fs.mkdir(path.dirname(planned.localPath), { recursive: true });
        await this.host.bot.downloadResolvedFile(remoteFile.file_path, planned.localPath);
        const resolvedAttachment: TelegramInboundAttachment = {
          ...attachment,
          fileName: planned.fileName,
          fileSize: resolvedSize,
        };
        staged.push({
          ...resolvedAttachment,
          fileName: planned.fileName,
          localPath: planned.localPath,
          relativePath: planned.relativePath,
          nativeImage: isNativeImageAttachment(resolvedAttachment),
        });
      } catch (error) {
        if (error instanceof UserFacingError) {
          throw error;
        }
        throw new Error(t(locale, 'attachment_download_failed', {
          name: attachment.fileName ?? attachment.fileUniqueId,
          error: formatUserError(error),
        }));
      }
    }
    return staged;
  }
}
