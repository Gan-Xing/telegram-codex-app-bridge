import fs from 'node:fs/promises';
import path from 'node:path';

import { getIlinkRuntimeContext } from './context.js';
import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from './pic_decrypt.js';
import type { MessageItem } from './types.js';
import { MessageItemType } from './types.js';
import { tempFileName } from './random.js';

const WEIXIN_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Download and decrypt a single IMAGE MessageItem to a local file.
 * Returns undefined if not an image or missing CDN refs.
 */
export async function downloadWeixinImageItemToFile(params: {
  item: MessageItem;
  cdnBaseUrl: string;
  destDir: string;
  label?: string;
}): Promise<string | undefined> {
  const log = getIlinkRuntimeContext().logger;
  const { item, cdnBaseUrl, destDir, label = 'weixin-image' } = params;

  if (item.type !== MessageItemType.IMAGE) {
    return undefined;
  }

  const img = item.image_item;
  if (!img?.media?.encrypt_query_param && !img?.media?.full_url) {
    return undefined;
  }

  const aesKeyBase64 = img.aeskey
    ? Buffer.from(img.aeskey, 'hex').toString('base64')
    : img.media?.aes_key;

  try {
    const buf = aesKeyBase64
      ? await downloadAndDecryptBuffer(
          img.media!.encrypt_query_param ?? '',
          aesKeyBase64,
          cdnBaseUrl,
          `${label} image`,
          img.media?.full_url,
        )
      : await downloadPlainCdnBuffer(
          img.media!.encrypt_query_param ?? '',
          cdnBaseUrl,
          `${label} image-plain`,
          img.media?.full_url,
        );

    if (buf.length > WEIXIN_IMAGE_MAX_BYTES) {
      log.warn(`${label}: image too large ${buf.length} bytes, skipping`);
      return undefined;
    }

    await fs.mkdir(destDir, { recursive: true });
    const name = tempFileName('weixin-inbound', '.bin');
    const filePath = path.join(destDir, name);
    await fs.writeFile(filePath, buf);
    log.debug(`${label}: saved image to ${filePath} bytes=${buf.length}`);
    return filePath;
  } catch (err) {
    log.error(`${label}: image download/decrypt failed: ${String(err)}`);
    return undefined;
  }
}
