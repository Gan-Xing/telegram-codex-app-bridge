import fs from 'node:fs';
import path from 'node:path';

import type { AppConfig } from '../../config.js';
import type { BridgeSessionCore } from '../../controller/controller.js';
import { toWeixinBridgeScopeId } from '../../core/bridge_scope.js';
import type { Logger } from '../../logger.js';
import type { BridgeStore } from '../../store/database.js';
import type { TelegramTextEvent } from '../../telegram/gateway.js';
import type { TelegramInboundAttachment } from '../../telegram/media.js';
import { getUpdates } from './ilink/api.js';
import { DEFAULT_CDN_BASE_URL } from './ilink/constants.js';
import { downloadWeixinImageItemToFile } from './ilink/media_image.js';
import {
  SESSION_EXPIRED_ERRCODE,
  getRemainingPauseMs,
  pauseSession,
} from './ilink/session_guard.js';
import { MessageItemType, MessageType } from './ilink/types.js';
import type { WeixinMessage } from './ilink/types.js';
import type { WeixinSavedAccount } from './account_store.js';
import { getWeixinSyncBufPath, loadGetUpdatesBuf, saveGetUpdatesBuf } from './sync_buf_store.js';

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

function isAllowedWeixinUser(config: AppConfig, fromUserId: string): boolean {
  if (config.wxAllowedIlinkUserIds.length === 0) {
    return true;
  }
  return config.wxAllowedIlinkUserIds.includes(fromUserId);
}

function buildTelegramShapedEvent(params: {
  scopeId: string;
  fromUserId: string;
  text: string;
  messageId: number;
  attachments: TelegramInboundAttachment[];
}): TelegramTextEvent {
  return {
    chatId: params.fromUserId,
    topicId: null,
    scopeId: params.scopeId,
    chatType: 'private',
    userId: params.fromUserId,
    text: params.text,
    messageId: params.messageId,
    attachments: params.attachments,
    entities: [],
    replyToBot: false,
    languageCode: 'zh',
  };
}

function normalizeInboundBaseUrl(account: WeixinSavedAccount): string {
  const raw = account.baseUrl.trim();
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw;
  }
  return `https://${raw}`;
}

export class WeixinChannelAdapter {
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];

  constructor(
    private readonly core: BridgeSessionCore,
    private readonly store: BridgeStore,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const accounts = this.listAccounts();
    if (accounts.length === 0) {
      this.logger.warn('weixin.start_no_accounts', { dir: this.config.weixinAccountsDir });
      return;
    }
    for (const account of accounts) {
      this.loops.push(this.runAccountLoop(account));
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  private listAccounts(): WeixinSavedAccount[] {
    if (!this.config.wxEnabled) {
      return [];
    }
    if (!fs.existsSync(this.config.weixinAccountsDir)) {
      return [];
    }
    const out: WeixinSavedAccount[] = [];
    for (const name of fs.readdirSync(this.config.weixinAccountsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(this.config.weixinAccountsDir, name), 'utf-8');
        const parsed = JSON.parse(raw) as WeixinSavedAccount;
        if (parsed.accountId && parsed.botToken && parsed.baseUrl) {
          out.push(parsed);
        }
      } catch {
        // skip invalid
      }
    }
    return out;
  }

  private async runAccountLoop(account: WeixinSavedAccount): Promise<void> {
    const accountId = account.accountId;
    const baseUrl = normalizeInboundBaseUrl(account);
    const cdnBaseUrl = DEFAULT_CDN_BASE_URL;
    const syncPath = getWeixinSyncBufPath(this.config.weixinSyncBufDir, accountId);
    let getUpdatesBuf = loadGetUpdatesBuf(syncPath) ?? '';
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;
    const signal = this.abort.signal;
    const inboundTemp = path.join(this.config.weixinMediaDir, 'inbound-temp', accountId);

    this.logger.info('weixin.monitor_started', { accountId, baseUrl });

    while (!signal.aborted) {
      try {
        const resp = await getUpdates({
          baseUrl,
          token: account.botToken,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
        });

        if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
        }

        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);
        if (isApiError) {
          const isSessionExpired =
            resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;
          if (isSessionExpired) {
            pauseSession(accountId);
            const pauseMs = getRemainingPauseMs(accountId);
            this.logger.error('weixin.session_expired', { accountId, pauseMs });
            consecutiveFailures = 0;
            try {
              await sleep(pauseMs, signal);
            } catch {
              return;
            }
            continue;
          }
          consecutiveFailures += 1;
          this.logger.warn('weixin.getupdates_failed', {
            accountId,
            ret: resp.ret,
            errcode: resp.errcode,
            consecutiveFailures,
          });
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            try {
              await sleep(BACKOFF_DELAY_MS, signal);
            } catch {
              return;
            }
          } else {
            try {
              await sleep(RETRY_DELAY_MS, signal);
            } catch {
              return;
            }
          }
          continue;
        }

        consecutiveFailures = 0;
        if (resp.get_updates_buf != null && resp.get_updates_buf !== '') {
          saveGetUpdatesBuf(syncPath, resp.get_updates_buf);
          getUpdatesBuf = resp.get_updates_buf;
        }

        for (const msg of resp.msgs ?? []) {
          await this.dispatchOneMessage(msg, accountId, cdnBaseUrl, inboundTemp);
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        consecutiveFailures += 1;
        this.logger.error('weixin.poll_error', { accountId, error: String(err) });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          try {
            await sleep(BACKOFF_DELAY_MS, signal);
          } catch {
            return;
          }
        } else {
          try {
            await sleep(RETRY_DELAY_MS, signal);
          } catch {
            return;
          }
        }
      }
    }
  }

  private async dispatchOneMessage(
    msg: WeixinMessage,
    accountId: string,
    cdnBaseUrl: string,
    inboundTemp: string,
  ): Promise<void> {
    if (msg.message_type === MessageType.BOT) {
      return;
    }
    const fromUserId = msg.from_user_id?.trim() ?? '';
    if (!fromUserId) {
      return;
    }
    if (!isAllowedWeixinUser(this.config, fromUserId)) {
      this.logger.debug('weixin.inbound_denied', { accountId, fromUserId });
      return;
    }

    const scopeId = toWeixinBridgeScopeId(accountId, fromUserId);
    if (msg.context_token) {
      this.store.setWeixinContextToken(scopeId, msg.context_token);
    }

    let text = '';
    const attachments: TelegramInboundAttachment[] = [];
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === MessageItemType.TEXT) {
        text += item.text_item?.text ?? '';
      } else if (item.type === MessageItemType.IMAGE) {
        const localPath = await downloadWeixinImageItemToFile({
          item,
          cdnBaseUrl,
          destDir: inboundTemp,
          label: `${scopeId}`,
        });
        if (localPath) {
          attachments.push({
            kind: 'document',
            fileId: 'weixin-image',
            fileUniqueId: `wx-${msg.message_id ?? Date.now()}-${attachments.length}`,
            fileName: path.basename(localPath),
            mimeType: 'image/jpeg',
            fileSize: null,
            width: null,
            height: null,
            durationSeconds: null,
            isAnimated: false,
            isVideo: false,
            localPath,
          });
        }
      }
    }

    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      return;
    }

    const midRaw = Number(msg.message_id);
    const messageId = Number.isFinite(midRaw) ? midRaw : Math.floor(Math.random() * 1_000_000_000);

    this.logger.info('weixin.inbound', {
      accountId,
      fromUserId,
      scopeId,
      textLen: trimmed.length,
      attachments: attachments.length,
    });

    const event = buildTelegramShapedEvent({
      scopeId,
      fromUserId,
      text: trimmed,
      messageId,
      attachments,
    });
    this.core.dispatchInboundLikeTelegramText(event);
  }
}
