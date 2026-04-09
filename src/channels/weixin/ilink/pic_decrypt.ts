import { decryptAesEcb } from './aes_ecb.js';
import { buildCdnDownloadUrl, ENABLE_CDN_URL_FALLBACK } from './cdn_url.js';
import { getIlinkRuntimeContext } from './context.js';

async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  const log = getIlinkRuntimeContext().logger;
  const res = await fetch(url);
  log.debug(`${label}: response status=${res.status} ok=${res.ok}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`${label}: CDN download ${res.status} ${res.statusText} body=${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`${label}: invalid aes_key encoding`);
}

export async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
): Promise<Buffer> {
  const log = getIlinkRuntimeContext().logger;
  const key = parseAesKey(aesKeyBase64, label);
  let url: string;
  if (fullUrl) {
    url = fullUrl;
  } else if (ENABLE_CDN_URL_FALLBACK) {
    url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  } else {
    throw new Error(`${label}: fullUrl is required`);
  }
  log.debug(`${label}: fetching url=${url}`);
  const encrypted = await fetchCdnBytes(url, label);
  const decrypted = decryptAesEcb(encrypted, key);
  return decrypted;
}

export async function downloadPlainCdnBuffer(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
): Promise<Buffer> {
  const log = getIlinkRuntimeContext().logger;
  let url: string;
  if (fullUrl) {
    url = fullUrl;
  } else if (ENABLE_CDN_URL_FALLBACK) {
    url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  } else {
    throw new Error(`${label}: fullUrl is required`);
  }
  log.debug(`${label}: fetching url=${url}`);
  return fetchCdnBytes(url, label);
}
