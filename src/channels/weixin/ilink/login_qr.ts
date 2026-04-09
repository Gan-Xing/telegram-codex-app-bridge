import { randomUUID } from 'node:crypto';

import { apiGetFetch } from './api.js';
import { FIXED_QR_BASE_URL } from './constants.js';
import { getIlinkRuntimeContext } from './context.js';
import { redactToken } from './redact.js';

type ActiveLogin = {
  sessionKey: string;
  id: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  botToken?: string;
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect';
  error?: string;
  currentApiBaseUrl?: string;
};

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

export const DEFAULT_ILINK_BOT_TYPE = '3';

const activeLogins = new Map<string, ActiveLogin>();

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpiredLogins(): void {
  for (const [id, login] of activeLogins) {
    if (!isLoginFresh(login)) {
      activeLogins.delete(id);
    }
  }
}

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QRCodeResponse> {
  const log = getIlinkRuntimeContext().logger;
  log.info(`Fetching QR code from: ${apiBaseUrl} bot_type=${botType}`);
  const rawText = await apiGetFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    label: 'fetchQRCode',
  });
  return JSON.parse(rawText) as QRCodeResponse;
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<StatusResponse> {
  const log = getIlinkRuntimeContext().logger;
  log.debug(`Long-poll QR status from: ${apiBaseUrl} qrcode=***`);
  try {
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: 'pollQRStatus',
    });
    log.debug(`pollQRStatus: body=${rawText.substring(0, 200)}`);
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      log.debug(`pollQRStatus: client-side timeout after ${QR_LONG_POLL_TIMEOUT_MS}ms, returning wait`);
      return { status: 'wait' };
    }
    log.warn(`pollQRStatus: network/gateway error, will retry: ${String(err)}`);
    return { status: 'wait' };
  }
}

export type WeixinQrStartResult = {
  qrcodeUrl?: string;
  message: string;
  sessionKey: string;
};

export type WeixinQrWaitResult = {
  connected: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
};

export async function startWeixinLoginWithQr(opts: {
  verbose?: boolean;
  timeoutMs?: number;
  force?: boolean;
  accountId?: string;
  apiBaseUrl: string;
  botType?: string;
}): Promise<WeixinQrStartResult> {
  const log = getIlinkRuntimeContext().logger;
  const sessionKey = opts.accountId || randomUUID();

  purgeExpiredLogins();

  const existing = activeLogins.get(sessionKey);
  if (!opts.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      qrcodeUrl: existing.qrcodeUrl,
      message: '二维码已就绪，请使用微信扫描。',
      sessionKey,
    };
  }

  try {
    const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
    log.info(`Starting Weixin login with bot_type=${botType}`);

    const qrResponse = await fetchQRCode(FIXED_QR_BASE_URL, botType);
    log.info(
      `QR code received, qrcode=${redactToken(qrResponse.qrcode)} imgContentLen=${qrResponse.qrcode_img_content?.length ?? 0}`,
    );

    const login: ActiveLogin = {
      sessionKey,
      id: randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
    };

    activeLogins.set(sessionKey, login);

    return {
      qrcodeUrl: qrResponse.qrcode_img_content,
      message: '使用微信扫描以下二维码，以完成连接。',
      sessionKey,
    };
  } catch (err) {
    log.error(`Failed to start Weixin login: ${String(err)}`);
    return {
      message: `Failed to start login: ${String(err)}`,
      sessionKey,
    };
  }
}

const MAX_QR_REFRESH_COUNT = 3;

export type WeixinLoginNotify = (line: string) => void;

export async function waitForWeixinLogin(opts: {
  timeoutMs?: number;
  verbose?: boolean;
  sessionKey: string;
  apiBaseUrl: string;
  botType?: string;
  /** Optional user-facing lines (e.g. process.stdout.write). */
  notify?: WeixinLoginNotify;
  /** Called when QR was refreshed after expiry so CLI can re-render terminal QR. */
  onQrRefreshed?: (qrcodeUrl: string) => void;
}): Promise<WeixinQrWaitResult> {
  const log = getIlinkRuntimeContext().logger;
  const notify = opts.notify ?? (() => {});

  const activeLogin = activeLogins.get(opts.sessionKey);

  if (!activeLogin) {
    log.warn(`waitForWeixinLogin: no active login sessionKey=${opts.sessionKey}`);
    return {
      connected: false,
      message: '当前没有进行中的登录，请先发起登录。',
    };
  }

  if (!isLoginFresh(activeLogin)) {
    log.warn(`waitForWeixinLogin: login QR expired sessionKey=${opts.sessionKey}`);
    activeLogins.delete(opts.sessionKey);
    return {
      connected: false,
      message: '二维码已过期，请重新生成。',
    };
  }

  const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  activeLogin.currentApiBaseUrl = FIXED_QR_BASE_URL;

  log.info('Starting to poll QR code status...');

  while (Date.now() < deadline) {
    try {
      const currentBaseUrl = activeLogin.currentApiBaseUrl ?? FIXED_QR_BASE_URL;
      const statusResponse = await pollQRStatus(currentBaseUrl, activeLogin.qrcode);
      log.debug(
        `pollQRStatus: status=${statusResponse.status} hasBotToken=${Boolean(statusResponse.bot_token)} hasBotId=${Boolean(statusResponse.ilink_bot_id)}`,
      );
      activeLogin.status = statusResponse.status;

      switch (statusResponse.status) {
        case 'wait':
          if (opts.verbose) {
            notify('.');
          }
          break;
        case 'scaned':
          if (!scannedPrinted) {
            notify('\n已扫码，请在微信中继续操作...\n');
            scannedPrinted = true;
          }
          break;
        case 'expired': {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            log.warn(
              `waitForWeixinLogin: QR expired ${MAX_QR_REFRESH_COUNT} times, giving up sessionKey=${opts.sessionKey}`,
            );
            activeLogins.delete(opts.sessionKey);
            return {
              connected: false,
              message: '登录超时：二维码多次过期，请重新开始登录流程。',
            };
          }

          notify(`\n二维码已过期，正在刷新...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
          log.info(
            `waitForWeixinLogin: QR expired, refreshing (${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})`,
          );

          try {
            const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
            const qrResponse = await fetchQRCode(FIXED_QR_BASE_URL, botType);
            activeLogin.qrcode = qrResponse.qrcode;
            activeLogin.qrcodeUrl = qrResponse.qrcode_img_content;
            activeLogin.startedAt = Date.now();
            scannedPrinted = false;
            log.info(`waitForWeixinLogin: new QR code obtained qrcode=${redactToken(qrResponse.qrcode)}`);
            notify('新二维码已生成，请重新扫描\n\n');
            activeLogins.set(opts.sessionKey, activeLogin);
            opts.onQrRefreshed?.(qrResponse.qrcode_img_content);
          } catch (refreshErr) {
            log.error(`waitForWeixinLogin: failed to refresh QR code: ${String(refreshErr)}`);
            activeLogins.delete(opts.sessionKey);
            return {
              connected: false,
              message: `刷新二维码失败: ${String(refreshErr)}`,
            };
          }
          break;
        }
        case 'scaned_but_redirect': {
          const redirectHost = statusResponse.redirect_host;
          if (redirectHost) {
            const newBaseUrl = `https://${redirectHost}`;
            activeLogin.currentApiBaseUrl = newBaseUrl;
            log.info(`waitForWeixinLogin: IDC redirect, switching polling host to ${redirectHost}`);
          } else {
            log.warn(
              `waitForWeixinLogin: received scaned_but_redirect but redirect_host is missing, continuing with current host`,
            );
          }
          break;
        }
        case 'confirmed': {
          if (!statusResponse.ilink_bot_id) {
            activeLogins.delete(opts.sessionKey);
            log.error('Login confirmed but ilink_bot_id missing from response');
            return {
              connected: false,
              message: '登录失败：服务器未返回 ilink_bot_id。',
            };
          }
          const botToken = statusResponse.bot_token?.trim();
          if (!botToken) {
            activeLogins.delete(opts.sessionKey);
            log.error('Login confirmed but bot_token missing from response');
            return {
              connected: false,
              message: '登录失败：服务器未返回 bot_token。',
            };
          }

          activeLogin.botToken = botToken;
          activeLogins.delete(opts.sessionKey);

          log.info(
            `Login confirmed ilink_bot_id=${statusResponse.ilink_bot_id} ilink_user_id=${redactToken(statusResponse.ilink_user_id)}`,
          );

          return {
            connected: true,
            botToken,
            accountId: statusResponse.ilink_bot_id,
            message: '与微信连接成功。',
            ...(statusResponse.baseurl !== undefined && statusResponse.baseurl !== ''
              ? { baseUrl: statusResponse.baseurl }
              : {}),
            ...(statusResponse.ilink_user_id !== undefined
              ? { userId: statusResponse.ilink_user_id }
              : {}),
          };
        }
      }
    } catch (err) {
      log.error(`Error polling QR status: ${String(err)}`);
      activeLogins.delete(opts.sessionKey);
      return {
        connected: false,
        message: `Login failed: ${String(err)}`,
      };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  log.warn(
    `waitForWeixinLogin: timed out waiting for QR scan sessionKey=${opts.sessionKey} timeoutMs=${timeoutMs}`,
  );
  activeLogins.delete(opts.sessionKey);
  return {
    connected: false,
    message: '登录超时，请重试。',
  };
}
