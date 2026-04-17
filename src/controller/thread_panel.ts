import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import { sanitizeAssistantText } from '../assistant_text.js';
import type {
  AppLocale,
  AppThreadTurn,
  AppThreadTurnItem,
  AppThreadWithTurns,
  CachedThread,
  ThreadBinding,
} from '../types.js';
import type { EngineProvider } from '../engine/types.js';
import type { TelegramCallbackEvent } from '../telegram/gateway.js';
import { classifyAgentOutput } from './activity.js';
import {
  buildThreadListKeyboard,
  formatThreadHistoryPreviewMessage,
  formatThreadsMessage,
  type ThreadListPresentationState,
  type ThreadHistoryPreviewTurn,
} from './presentation.js';

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;
type ThreadRenameAction = 'start' | 'confirm' | 'cancel';
type ThreadArchiveMode = 'archive' | 'unarchive';
type ThreadArchiveAction = 'start' | 'confirm' | 'cancel';
type ThreadListNavigationAction = 'prev' | 'next' | 'clear' | 'active' | 'archived';

interface ThreadRenameDraft {
  threadId: string;
  currentName: string;
  proposedName: string | null;
  promptMessageId: number;
  createdAt: number;
}

interface ThreadArchiveDraft {
  threadId: string;
  currentName: string;
  mode: ThreadArchiveMode;
  promptMessageId: number;
  createdAt: number;
}

interface ThreadPanelHost {
  config: {
    threadListLimit: number;
    codexAppSyncOnOpen: boolean;
    allowThreadArchive: boolean;
  };
  store: BridgeStore;
  logger: Logger;
  app: Pick<EngineProvider, 'listThreads' | 'readThread' | 'readThreadWithTurns' | 'renameThread' | 'archiveThread' | 'unarchiveThread'>;
  bindCachedThread: (scopeId: string, threadId: string) => Promise<ThreadBinding>;
  tryRevealThread: (scopeId: string, threadId: string, source: 'open') => Promise<string | null>;
  clearBinding: (scopeId: string) => void;
  getActiveTurnThreadId: (scopeId: string) => string | null;
  sendMessage: (scopeId: string, text: string, inlineKeyboard?: InlineKeyboard) => Promise<number>;
  sendHtmlMessage: (scopeId: string, text: string, inlineKeyboard?: InlineKeyboard) => Promise<number>;
  editMessage: (scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard) => Promise<void>;
  editHtmlMessage: (scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard) => Promise<void>;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
}

const THREAD_HISTORY_PREVIEW_TURN_LIMIT = 3;

export class ThreadPanelCoordinator {
  private readonly threadRenameDrafts = new Map<string, ThreadRenameDraft>();
  private readonly threadArchiveDrafts = new Map<string, ThreadArchiveDraft>();
  private readonly threadListState = new Map<string, ThreadListPresentationState>();

  constructor(private readonly host: ThreadPanelHost) {}

  clearDrafts(): void {
    this.threadRenameDrafts.clear();
    this.threadArchiveDrafts.clear();
    this.threadListState.clear();
  }

  async showThreadsPanel(
    scopeId: string,
    messageId: number | undefined,
    searchTerm: string | null | undefined,
    locale: AppLocale,
    options: { offset?: number; archived?: boolean } = {},
  ): Promise<void> {
    const archived = Boolean(options.archived);
    const binding = archived ? null : this.host.store.getBinding(scopeId);
    const pageSize = Math.max(1, this.host.config.threadListLimit);
    const offset = Math.max(0, options.offset ?? 0);
    const threads = await this.host.app.listThreads({
      limit: offset + pageSize + 1,
      searchTerm: searchTerm ?? null,
      scopeId,
      archived,
    });
    const visibleThreads = threads.slice(offset, offset + pageSize);
    const hasNextPage = threads.length > offset + visibleThreads.length;
    const presentationState: ThreadListPresentationState = {
      offset,
      pageSize,
      hasPreviousPage: offset > 0,
      hasNextPage,
      archived,
      searchTerm: searchTerm ?? null,
    };
    this.threadListState.set(scopeId, presentationState);
    const cached: CachedThread[] = visibleThreads.map((thread, index) => ({
      index: offset + index,
      threadId: thread.threadId,
      name: this.host.store.getThreadNameOverride(scopeId, thread.threadId) ?? thread.name,
      preview: sanitizeAssistantText(thread.preview) ?? thread.preview,
      cwd: thread.cwd,
      modelProvider: thread.modelProvider,
      status: thread.status,
      updatedAt: thread.updatedAt,
    }));
    this.host.store.cacheThreadList(scopeId, cached);
    const text = formatThreadsMessage(locale, cached, binding?.threadId ?? null, searchTerm ?? null, presentationState, {
      allowThreadArchive: this.host.config.allowThreadArchive,
    });
    const keyboard = buildThreadListKeyboard(locale, cached, presentationState, {
      allowThreadArchive: this.host.config.allowThreadArchive,
    });
    if (messageId !== undefined) {
      await this.host.editHtmlMessage(scopeId, messageId, text, keyboard);
      return;
    }
    await this.host.sendHtmlMessage(scopeId, text, keyboard);
  }

  async handleThreadListNavigationCallback(
    event: TelegramCallbackEvent,
    action: ThreadListNavigationAction,
    locale: AppLocale,
  ): Promise<void> {
    const state = this.threadListState.get(event.scopeId) ?? {
      offset: 0,
      pageSize: Math.max(1, this.host.config.threadListLimit),
      hasPreviousPage: false,
      hasNextPage: false,
      archived: false,
      searchTerm: null,
    };
    const nextOffset = action === 'prev'
      ? Math.max(0, state.offset - state.pageSize)
      : action === 'next'
        ? state.offset + state.pageSize
        : 0;
    const nextSearchTerm = action === 'clear' ? null : (state.searchTerm ?? null);
    const archived = action === 'archived' ? true : action === 'active' ? false : state.archived;
    await this.showThreadsPanel(event.scopeId, event.messageId, nextSearchTerm, locale, { offset: nextOffset, archived });
    await this.host.answerCallback(event.callbackQueryId, t(locale, action === 'clear' ? 'threads_filter_cleared_short' : 'decision_recorded'));
  }

  async handleThreadOpenCallback(event: TelegramCallbackEvent, threadId: string, locale: AppLocale): Promise<void> {
    const scopeId = event.scopeId;
    let binding: ThreadBinding;
    try {
      binding = await this.host.bindCachedThread(scopeId, threadId);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'thread_no_longer_available'));
        return;
      }
      throw error;
    }

    const threads = this.host.store.listCachedThreads(scopeId);
    const state = this.threadListState.get(scopeId) ?? null;
    if (threads.length > 0) {
      await this.host.editHtmlMessage(
        scopeId,
        event.messageId,
        formatThreadsMessage(locale, threads, binding.threadId, state?.searchTerm ?? null, state ?? undefined, {
          allowThreadArchive: this.host.config.allowThreadArchive,
        }),
        buildThreadListKeyboard(locale, threads, state ?? {
          offset: 0,
          pageSize: threads.length,
          hasPreviousPage: false,
          hasNextPage: false,
          archived: false,
          searchTerm: null,
        }, {
          allowThreadArchive: this.host.config.allowThreadArchive,
        }),
      );
    }

    let callbackText = t(locale, 'thread_opened');
    if (this.host.config.codexAppSyncOnOpen) {
      const revealError = await this.host.tryRevealThread(scopeId, binding.threadId, 'open');
      callbackText = revealError ? t(locale, 'opened_sync_failed_short') : t(locale, 'opened_in_codex_short');
    }
    await this.host.answerCallback(event.callbackQueryId, callbackText);
    await this.renderThreadHistoryPreview(scopeId, binding.threadId, locale);
  }

  async handleThreadRenameCallback(
    event: TelegramCallbackEvent,
    action: ThreadRenameAction,
    threadId: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if (action === 'start') {
      const started = await this.startThreadRenameDraft(scopeId, threadId, locale);
      await this.host.answerCallback(
        event.callbackQueryId,
        started ? t(locale, 'thread_rename_started') : t(locale, 'thread_no_longer_available'),
      );
      return;
    }

    const draft = this.threadRenameDrafts.get(scopeId) ?? null;
    if (!draft || draft.threadId !== threadId) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'thread_rename_missing'));
      return;
    }

    if (action === 'cancel') {
      await this.resolveThreadRenameDraft(scopeId, draft, t(locale, 'thread_rename_cancelled'));
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'thread_rename_cancelled'));
      return;
    }

    if (!draft.proposedName) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'thread_rename_input_required'));
      return;
    }

    try {
      await this.host.app.renameThread(threadId, draft.proposedName, scopeId);
    } catch (error) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'thread_rename_sync_failed', { error: formatUserError(error) }));
      return;
    }

    this.host.store.setThreadNameOverride(scopeId, threadId, draft.proposedName);
    await this.resolveThreadRenameDraft(scopeId, draft, t(locale, 'thread_rename_updated', { value: draft.proposedName }));
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    await this.refreshThreadsPanel(scopeId, locale);
  }

  async handleThreadArchiveCallback(
    event: TelegramCallbackEvent,
    mode: ThreadArchiveMode,
    action: ThreadArchiveAction,
    threadId: string,
    locale: AppLocale,
  ): Promise<void> {
    const scopeId = event.scopeId;
    if (action === 'start') {
      if (mode === 'archive' && this.host.getActiveTurnThreadId(scopeId) === threadId) {
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
        return;
      }
      const started = await this.startThreadArchiveDraft(scopeId, mode, threadId, locale);
      await this.host.answerCallback(
        event.callbackQueryId,
        started
          ? t(locale, mode === 'archive' ? 'thread_archive_started' : 'thread_unarchive_started')
          : t(locale, 'thread_no_longer_available'),
      );
      return;
    }

    const draft = this.threadArchiveDrafts.get(scopeId) ?? null;
    if (!draft || draft.threadId !== threadId || draft.mode !== mode) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'thread_archive_missing'));
      return;
    }

    if (action === 'cancel') {
      await this.resolveThreadArchiveDraft(
        scopeId,
        draft,
        t(locale, draft.mode === 'archive' ? 'thread_archive_cancelled' : 'thread_unarchive_cancelled'),
      );
      await this.host.answerCallback(
        event.callbackQueryId,
        t(locale, draft.mode === 'archive' ? 'thread_archive_cancelled' : 'thread_unarchive_cancelled'),
      );
      return;
    }

    const currentBinding = this.host.store.getBinding(scopeId);
    try {
      if (draft.mode === 'archive') {
        await this.host.app.archiveThread(threadId, scopeId);
        if (currentBinding?.threadId === threadId) {
          this.host.clearBinding(scopeId);
        }
      } else {
        await this.host.app.unarchiveThread(threadId, scopeId);
      }
    } catch (error) {
      await this.host.answerCallback(
        event.callbackQueryId,
        t(locale, draft.mode === 'archive' ? 'thread_archive_sync_failed' : 'thread_unarchive_sync_failed', { error: formatUserError(error) }),
      );
      return;
    }

    const resolvedText = draft.mode === 'archive'
      ? (currentBinding?.threadId === threadId
          ? t(locale, 'thread_archived_current_cleared')
          : t(locale, 'thread_archived'))
      : t(locale, 'thread_unarchived');
    await this.resolveThreadArchiveDraft(scopeId, draft, resolvedText);
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    await this.refreshThreadsPanel(scopeId, locale);
  }

  async handleThreadRenameText(scopeId: string, text: string, locale: AppLocale): Promise<boolean> {
    const draft = this.threadRenameDrafts.get(scopeId) ?? null;
    if (!draft) {
      return false;
    }

    const nextName = normalizeThreadRenameInput(text);
    if (!nextName) {
      await this.host.sendMessage(scopeId, t(locale, 'thread_rename_invalid'));
      return true;
    }

    draft.proposedName = nextName;
    const reviewText = t(locale, 'thread_rename_review', {
      threadId: draft.threadId,
      from: truncateInline(draft.currentName, 60),
      to: truncateInline(nextName, 60),
    });
    const keyboard = threadRenamePromptKeyboard(locale, draft.threadId, true);
    try {
      await this.host.editMessage(scopeId, draft.promptMessageId, reviewText, keyboard);
      return true;
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        this.host.logger.warn('thread.rename_prompt_edit_failed', {
          scopeId,
          threadId: draft.threadId,
          messageId: draft.promptMessageId,
          error: String(error),
        });
      }
    }

    draft.promptMessageId = await this.host.sendMessage(scopeId, reviewText, keyboard);
    return true;
  }

  async renderThreadHistoryPreview(scopeId: string, threadId: string, locale: AppLocale): Promise<void> {
    try {
      const thread = await this.host.app.readThreadWithTurns(threadId, scopeId);
      if (!thread) {
        return;
      }
      const text = formatThreadHistoryPreviewMessage(
        locale,
        {
          threadId: thread.threadId,
          name: this.host.store.getThreadNameOverride(scopeId, thread.threadId) ?? thread.name,
          preview: thread.preview,
        },
        buildThreadHistoryPreviewTurns(thread.turns, THREAD_HISTORY_PREVIEW_TURN_LIMIT),
      );
      const messageId = await this.host.sendHtmlMessage(scopeId, text);
      this.host.store.saveThreadHistoryPreview({ scopeId, threadId: thread.threadId, messageId });
    } catch (error) {
      this.host.logger.warn('telegram.thread_history_preview_failed', {
        scopeId,
        threadId,
        error: String(error),
      });
    }
  }

  private async refreshThreadsPanel(scopeId: string, locale: AppLocale): Promise<void> {
    try {
      const state = this.threadListState.get(scopeId) ?? null;
      await this.showThreadsPanel(scopeId, undefined, state?.searchTerm ?? null, locale, {
        offset: state?.offset ?? 0,
        archived: state?.archived ?? false,
      });
    } catch (error) {
      this.host.logger.warn('thread.panel_refresh_failed', { scopeId, error: String(error) });
    }
  }

  private async startThreadRenameDraft(scopeId: string, threadId: string, locale: AppLocale): Promise<boolean> {
    const existing = this.threadRenameDrafts.get(scopeId) ?? null;
    if (existing) {
      await this.resolveThreadRenameDraft(scopeId, existing, t(locale, 'thread_rename_cancelled'));
    }

    const cached = this.host.store.listCachedThreads(scopeId).find((thread) => thread.threadId === threadId) ?? null;
    if (!cached) {
      const thread = await this.host.app.readThread(threadId, false, scopeId);
      if (!thread) {
        return false;
      }
      return this.createThreadRenameDraft(
        scopeId,
        threadId,
        normalizeThreadRenameLabel(thread.name || thread.preview || t(locale, 'untitled')),
        locale,
      );
    }

    return this.createThreadRenameDraft(
      scopeId,
      threadId,
      normalizeThreadRenameLabel(cached.name || cached.preview || t(locale, 'untitled')),
      locale,
    );
  }

  private async startThreadArchiveDraft(
    scopeId: string,
    mode: ThreadArchiveMode,
    threadId: string,
    locale: AppLocale,
  ): Promise<boolean> {
    const existing = this.threadArchiveDrafts.get(scopeId) ?? null;
    if (existing) {
      await this.resolveThreadArchiveDraft(
        scopeId,
        existing,
        t(locale, existing.mode === 'archive' ? 'thread_archive_cancelled' : 'thread_unarchive_cancelled'),
      );
    }

    const cached = this.host.store.listCachedThreads(scopeId).find((thread) => thread.threadId === threadId) ?? null;
    if (!cached) {
      const thread = await this.host.app.readThread(threadId, false, scopeId);
      if (!thread) {
        return false;
      }
      return this.createThreadArchiveDraft(
        scopeId,
        mode,
        threadId,
        normalizeThreadRenameLabel(thread.name || thread.preview || t(locale, 'untitled')),
        locale,
      );
    }

    return this.createThreadArchiveDraft(
      scopeId,
      mode,
      threadId,
      normalizeThreadRenameLabel(cached.name || cached.preview || t(locale, 'untitled')),
      locale,
    );
  }

  private async createThreadRenameDraft(
    scopeId: string,
    threadId: string,
    currentName: string,
    locale: AppLocale,
  ): Promise<boolean> {
    const promptMessageId = await this.host.sendMessage(
      scopeId,
      t(locale, 'thread_rename_prompt', { threadId, value: truncateInline(currentName, 60) }),
      threadRenamePromptKeyboard(locale, threadId, false),
    );
    this.threadRenameDrafts.set(scopeId, {
      threadId,
      currentName,
      proposedName: null,
      promptMessageId,
      createdAt: Date.now(),
    });
    return true;
  }

  private async createThreadArchiveDraft(
    scopeId: string,
    mode: ThreadArchiveMode,
    threadId: string,
    currentName: string,
    locale: AppLocale,
  ): Promise<boolean> {
    const key = mode === 'archive' ? 'thread_archive_prompt' : 'thread_unarchive_prompt';
    const promptMessageId = await this.host.sendMessage(
      scopeId,
      t(locale, key, { threadId, value: truncateInline(currentName, 60) }),
      threadArchivePromptKeyboard(locale, mode, threadId),
    );
    this.threadArchiveDrafts.set(scopeId, {
      threadId,
      currentName,
      mode,
      promptMessageId,
      createdAt: Date.now(),
    });
    return true;
  }

  private async resolveThreadRenameDraft(scopeId: string, draft: ThreadRenameDraft, text: string): Promise<void> {
    this.threadRenameDrafts.delete(scopeId);
    try {
      await this.host.editMessage(scopeId, draft.promptMessageId, text, []);
      return;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        return;
      }
      this.host.logger.warn('thread.rename_prompt_resolve_failed', {
        scopeId,
        threadId: draft.threadId,
        messageId: draft.promptMessageId,
        error: String(error),
      });
    }
    await this.host.sendMessage(scopeId, text);
  }

  private async resolveThreadArchiveDraft(scopeId: string, draft: ThreadArchiveDraft, text: string): Promise<void> {
    this.threadArchiveDrafts.delete(scopeId);
    try {
      await this.host.editMessage(scopeId, draft.promptMessageId, text, []);
      return;
    } catch (error) {
      if (isTelegramMessageGone(error)) {
        return;
      }
      this.host.logger.warn('thread.archive_prompt_resolve_failed', {
        scopeId,
        threadId: draft.threadId,
        messageId: draft.promptMessageId,
        error: String(error),
      });
    }
    await this.host.sendMessage(scopeId, text);
  }
}

function buildThreadHistoryPreviewTurns(
  turns: AppThreadWithTurns['turns'],
  limit: number,
): ThreadHistoryPreviewTurn[] {
  const normalized: ThreadHistoryPreviewTurn[] = [];
  for (const turn of turns) {
    const previewTurn = normalizeThreadHistoryPreviewTurn(turn);
    if (previewTurn) {
      normalized.push(previewTurn);
    }
  }
  return normalized.slice(Math.max(0, normalized.length - limit));
}

function normalizeThreadHistoryPreviewTurn(turn: AppThreadTurn): ThreadHistoryPreviewTurn | null {
  const userText = findLastThreadTurnText(turn.items, isUserThreadTurnItem);
  const finalAssistantText = findLastThreadTurnText(turn.items, (item) => (
    isAssistantThreadTurnItem(item) && classifyAgentOutput(item.phase, true) === 'final_answer'
  ));
  const fallbackAssistantText = findLastThreadTurnText(turn.items, isAssistantThreadTurnItem);
  const assistantText = finalAssistantText ?? fallbackAssistantText ?? sanitizeThreadHistoryPreviewText(turn.error);
  if (!userText && !assistantText) {
    return null;
  }
  return {
    userText,
    assistantText,
    status: classifyThreadHistoryPreviewStatus(turn, Boolean(finalAssistantText), Boolean(fallbackAssistantText)),
  };
}

function classifyThreadHistoryPreviewStatus(
  turn: AppThreadTurn,
  hasFinalAssistantText: boolean,
  hasAssistantText: boolean,
): ThreadHistoryPreviewTurn['status'] {
  const normalizedStatus = normalizeHistoryStatus(turn.status);
  if (normalizedStatus.includes('interrupt') || normalizedStatus.includes('cancel')) {
    return 'interrupted';
  }
  if (normalizedStatus.includes('fail') || normalizedStatus.includes('error') || turn.error) {
    return 'failed';
  }
  if (hasFinalAssistantText) {
    return 'complete';
  }
  if (hasAssistantText) {
    return 'partial';
  }
  if (
    normalizedStatus.includes('active')
    || normalizedStatus.includes('pending')
    || normalizedStatus.includes('progress')
    || normalizedStatus.includes('running')
  ) {
    return 'partial';
  }
  return 'failed';
}

function findLastThreadTurnText(
  items: AppThreadTurnItem[],
  predicate: (item: AppThreadTurnItem) => boolean,
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || !predicate(item)) {
      continue;
    }
    const text = sanitizeThreadHistoryPreviewText(item.text);
    if (text) {
      return text;
    }
  }
  return null;
}

function isUserThreadTurnItem(item: AppThreadTurnItem): boolean {
  return normalizeThreadTurnItemType(item.type) === 'usermessage';
}

function isAssistantThreadTurnItem(item: AppThreadTurnItem): boolean {
  const type = normalizeThreadTurnItemType(item.type);
  return type === 'agentmessage' || type === 'assistantmessage';
}

function normalizeThreadTurnItemType(value: string): string {
  return value.replace(/[^a-z]/gi, '').toLowerCase();
}

function sanitizeThreadHistoryPreviewText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalizedValue = (sanitizeAssistantText(value) ?? value).replace(/\r\n?/g, '\n').trim();
  if (!normalizedValue) {
    return null;
  }
  const lines = normalizedValue
    .split('\n')
    .map((line) => normalizeThreadHistoryText(stripTelegramHtml(line)))
    .filter((line): line is string => line !== null);
  if (lines.length === 0) {
    return null;
  }
  const hasPreviewShell = lines.some((line) => isThreadHistoryPreviewShellLine(line));
  const filteredLines = hasPreviewShell
    ? lines.filter((line) => !isThreadHistoryPreviewShellLine(line) && !isThreadHistoryPreviewSpeakerLine(line))
    : lines;
  if (filteredLines.length === 0) {
    return hasPreviewShell ? null : normalizeThreadHistoryText(normalizedValue);
  }
  return normalizeThreadHistoryText(filteredLines.join('\n\n'));
}

function normalizeThreadHistoryText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : null;
}

function stripTelegramHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

function isThreadHistoryPreviewShellLine(value: string): boolean {
  const normalized = normalizeHistoryPreviewLine(value);
  return normalized === 'recent context'
    || normalized === '最近会话'
    || normalized === 'recent turns'
    || normalized === 'recent turns:'
    || normalized === '最近几轮'
    || normalized === '最近几轮:'
    || normalized === '最近几轮：'
    || normalized.startsWith('switched to:')
    || normalized.startsWith('已切换到:')
    || normalized.startsWith('已切换到：')
    || normalized.startsWith('thread:')
    || normalized.startsWith('线程:')
    || normalized.startsWith('线程：')
    || /^turn \d+$/.test(normalized)
    || /^第 ?\d+ ?轮$/.test(normalized);
}

function isThreadHistoryPreviewSpeakerLine(value: string): boolean {
  const normalized = normalizeHistoryPreviewLine(value);
  return /^(you|你)\s*[:：]/.test(normalized)
    || /^codex(?:\s*[（(][^）)]*[）)])?\s*[:：]/.test(normalized);
}

function normalizeHistoryPreviewLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeHistoryStatus(value: string | null): string {
  return (value ?? '').replace(/[^a-z]/gi, '').toLowerCase();
}

function threadRenamePromptKeyboard(
  locale: AppLocale,
  threadId: string,
  hasProposedName: boolean,
): InlineKeyboard {
  if (!hasProposedName) {
    return [[{ text: t(locale, 'button_cancel'), callback_data: `thread:rename:cancel:${threadId}` }]];
  }
  return [[
    { text: t(locale, 'button_confirm'), callback_data: `thread:rename:confirm:${threadId}` },
    { text: t(locale, 'button_cancel'), callback_data: `thread:rename:cancel:${threadId}` },
  ]];
}

function threadArchivePromptKeyboard(locale: AppLocale, mode: ThreadArchiveMode, threadId: string): InlineKeyboard {
  const prefix = mode === 'archive' ? 'thread:archive' : 'thread:unarchive';
  return [[
    { text: t(locale, 'button_confirm'), callback_data: `${prefix}:confirm:${threadId}` },
    { text: t(locale, 'button_cancel'), callback_data: `${prefix}:cancel:${threadId}` },
  ]];
}

function truncateInline(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeThreadRenameLabel(value: string): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted || 'Untitled';
}

function normalizeThreadRenameInput(value: string): string | null {
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted || compacted.length > 60) {
    return null;
  }
  return compacted;
}

function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isThreadNotFoundError(error: unknown): boolean {
  return error instanceof Error && /(thread not found|no rollout found for thread id)/i.test(error.message);
}

function isTelegramMessageGone(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message to delete not found')
    || message.includes('message to edit not found')
    || message.includes('message not found');
}
