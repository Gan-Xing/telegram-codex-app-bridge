import path from 'node:path';

const EXTENSION_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
};

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
};

export function getMimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? 'application/octet-stream';
}

export function getExtensionFromMime(mimeType: string): string {
  const ct = mimeType.split(';')[0]!.trim().toLowerCase();
  return MIME_TO_EXTENSION[ct] ?? '.bin';
}

export function getExtensionFromContentTypeOrUrl(contentType: string | null, url: string): string {
  if (contentType) {
    const ext = getExtensionFromMime(contentType);
    if (ext !== '.bin') return ext;
  }
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return EXTENSION_TO_MIME[ext] ? ext : '.bin';
}
