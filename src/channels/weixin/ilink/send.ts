import { sendMessage as sendMessageApi } from './api.js';
import type { WeixinApiOptions } from './api.js';
import { getIlinkRuntimeContext } from './context.js';
import { generateId } from './random.js';
import type { MessageItem, SendMessageReq, WeixinMessage } from './types.js';
import { MessageItemType, MessageState, MessageType } from './types.js';
import type { UploadedFileInfo } from './upload.js';

function generateClientId(): string {
  return generateId('bridge-weixin');
}

function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, clientId } = params;
  const item_list: MessageItem[] = text ? [{ type: MessageItemType.TEXT, text_item: { text } }] : [];
  const msg: WeixinMessage = {
    from_user_id: '',
    to_user_id: to,
    client_id: clientId,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    ...(item_list.length > 0 ? { item_list } : {}),
    ...(contextToken !== undefined && contextToken !== '' ? { context_token: contextToken } : {}),
  };
  return { msg };
}

export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const log = getIlinkRuntimeContext().logger;
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    log.warn(`sendMessageWeixin: contextToken missing for to=${to}, sending without context`);
  }
  const clientId = generateClientId();
  const req = buildTextMessageReq({
    to,
    text,
    clientId,
    ...(opts.contextToken !== undefined && opts.contextToken !== '' ? { contextToken: opts.contextToken } : {}),
  });
  try {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      body: req,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.token !== undefined && opts.token !== '' ? { token: opts.token } : {}),
    });
  } catch (err) {
    log.error(`sendMessageWeixin: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
  return { messageId: clientId };
}

async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinApiOptions & { contextToken?: string };
  label: string;
}): Promise<{ messageId: string }> {
  const log = getIlinkRuntimeContext().logger;
  const { to, text, mediaItem, opts, label } = params;

  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  let lastClientId = '';
  for (const item of items) {
    lastClientId = generateClientId();
    const msg: WeixinMessage = {
      from_user_id: '',
      to_user_id: to,
      client_id: lastClientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [item],
      ...(opts.contextToken !== undefined && opts.contextToken !== '' ? { context_token: opts.contextToken } : {}),
    };
    const req: SendMessageReq = { msg };
    try {
      await sendMessageApi({
        baseUrl: opts.baseUrl,
        body: req,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.token !== undefined && opts.token !== '' ? { token: opts.token } : {}),
      });
    } catch (err) {
      log.error(`${label}: failed to=${to} clientId=${lastClientId} err=${String(err)}`);
      throw err;
    }
  }

  log.info(`${label}: success to=${to} clientId=${lastClientId}`);
  return { messageId: lastClientId };
}

function uploadedAesKeyBase64(uploaded: UploadedFileInfo): string {
  return Buffer.from(uploaded.aeskey, 'hex').toString('base64');
}

export async function sendImageMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const log = getIlinkRuntimeContext().logger;
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    log.warn(`sendImageMessageWeixin: contextToken missing for to=${to}, sending without context`);
  }
  log.info(
    `sendImageMessageWeixin: to=${to} filekey=${uploaded.filekey} fileSize=${uploaded.fileSize} aeskey=present`,
  );

  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploadedAesKeyBase64(uploaded),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: imageItem, opts, label: 'sendImageMessageWeixin' });
}
