import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getUploadUrl } from './api.js';
import type { WeixinApiOptions } from './api.js';
import { aesEcbPaddedSize } from './aes_ecb.js';
import { uploadBufferToCdn } from './cdn_upload.js';
import { getIlinkRuntimeContext } from './context.js';
import { getExtensionFromContentTypeOrUrl } from './mime.js';
import { tempFileName } from './random.js';
import { UploadMediaType } from './types.js';

export type UploadedFileInfo = {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
};

async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  label: string;
}): Promise<UploadedFileInfo> {
  const log = getIlinkRuntimeContext().logger;
  const { filePath, toUserId, opts, cdnBaseUrl, mediaType, label } = params;

  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);

  log.debug(`${label}: file=${filePath} rawsize=${rawsize} filekey=${filekey}`);

  const uploadUrlResp = await getUploadUrl({
    ...opts,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`${label}: getUploadUrl returned no upload URL`);
  }

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    filekey,
    cdnBaseUrl,
    aeskey,
    label: `${label}[filekey=${filekey}]`,
    ...(uploadFullUrl ? { uploadFullUrl } : {}),
    ...(uploadParam ? { uploadParam } : {}),
  });

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString('hex'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

export async function uploadFileToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.IMAGE,
    label: 'uploadFileToWeixin',
  });
}

export async function downloadRemoteImageToTemp(url: string, destDir: string): Promise<string> {
  const log = getIlinkRuntimeContext().logger;
  log.debug(`downloadRemoteImageToTemp: fetching url=${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`remote media download failed: ${res.status} url=${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(destDir, { recursive: true });
  const ext = getExtensionFromContentTypeOrUrl(res.headers.get('content-type'), url);
  const name = tempFileName('weixin-remote', ext);
  const filePath = path.join(destDir, name);
  await fs.writeFile(filePath, buf);
  return filePath;
}
