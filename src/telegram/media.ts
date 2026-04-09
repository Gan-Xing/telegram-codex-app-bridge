import path from 'node:path';

export const TELEGRAM_INBOX_DIR = '.telegram-inbox';
export const TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

const FALLBACK_EXTENSION_BY_KIND: Record<TelegramAttachmentKind, string> = {
  photo: '.jpg',
  document: '',
  audio: '.mp3',
  voice: '.ogg',
  video: '.mp4',
  animation: '.mp4',
  sticker: '.webp',
  videoNote: '.mp4',
};

const MIME_EXTENSION_MAP: Record<string, string> = {
  'application/gzip': '.gz',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

export type TelegramAttachmentKind =
  | 'photo'
  | 'document'
  | 'audio'
  | 'voice'
  | 'video'
  | 'animation'
  | 'sticker'
  | 'videoNote';

export interface TelegramInboundAttachment {
  kind: TelegramAttachmentKind;
  fileId: string;
  fileUniqueId: string;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  isAnimated: boolean;
  isVideo: boolean;
  /** When set, {@link stageAttachments} copies this file instead of Telegram Bot API download. */
  localPath?: string;
}

export interface StagedTelegramAttachment extends TelegramInboundAttachment {
  fileName: string;
  localPath: string;
  relativePath: string;
  nativeImage: boolean;
}

interface PlannedAttachmentPath {
  fileName: string;
  localPath: string;
  relativePath: string;
}

export function isNativeImageAttachment(attachment: TelegramInboundAttachment): boolean {
  if (attachment.kind === 'photo') {
    return true;
  }
  if (attachment.kind === 'sticker') {
    return !attachment.isAnimated && !attachment.isVideo;
  }
  if (attachment.kind !== 'document') {
    return false;
  }
  const lowerMime = attachment.mimeType?.toLowerCase() ?? '';
  if (lowerMime === 'image/jpeg' || lowerMime === 'image/png' || lowerMime === 'image/webp' || lowerMime === 'image/gif') {
    return true;
  }
  const extension = extensionFromName(attachment.fileName);
  return extension === '.jpg' || extension === '.jpeg' || extension === '.png' || extension === '.webp' || extension === '.gif';
}

export function planAttachmentStoragePath(
  cwd: string,
  threadId: string,
  attachment: TelegramInboundAttachment,
  remoteFilePath?: string | null,
  now = new Date(),
): PlannedAttachmentPath {
  const dateSegment = now.toISOString().slice(0, 10);
  const threadSegment = sanitizePathSegment(threadId);
  const timestamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const resolvedFileName = resolveAttachmentFileName(attachment, remoteFilePath);
  const uniquePrefix = `${timestamp}-${sanitizePathSegment(attachment.fileUniqueId).slice(0, 16)}`;
  const joinedName = truncateFileName(`${uniquePrefix}-${resolvedFileName}`, 160);
  const relativePath = path.join(TELEGRAM_INBOX_DIR, dateSegment, threadSegment, joinedName);
  return {
    fileName: resolvedFileName,
    localPath: path.resolve(cwd, relativePath),
    relativePath,
  };
}

export function buildAttachmentPrompt(
  userText: string,
  attachments: readonly StagedTelegramAttachment[],
): string {
  const normalizedText = userText.trim();
  const lines: string[] = [];
  if (normalizedText) {
    lines.push(normalizedText, '');
  } else {
    lines.push('User sent Telegram attachments without a caption.', '');
  }
  lines.push('Telegram attachments:');
  attachments.forEach((attachment, index) => {
    lines.push(`${index + 1}. ${describeAttachment(attachment)}`);
    lines.push(`   filename: ${attachment.fileName}`);
    lines.push(`   path: ${attachment.localPath}`);
    if (attachment.mimeType) lines.push(`   mime: ${attachment.mimeType}`);
    if (attachment.fileSize !== null) lines.push(`   size_bytes: ${attachment.fileSize}`);
    if (attachment.width !== null && attachment.height !== null) {
      lines.push(`   dimensions: ${attachment.width}x${attachment.height}`);
    }
    if (attachment.durationSeconds !== null) {
      lines.push(`   duration_seconds: ${attachment.durationSeconds}`);
    }
    if (attachment.nativeImage) {
      lines.push('   attached_as: localImage');
    }
  });
  lines.push('', 'Use the local file paths above when you inspect these attachments.');
  return lines.join('\n');
}

export function summarizeTelegramInput(text: string, attachments: readonly TelegramInboundAttachment[]): string {
  const lines: string[] = [];
  const normalizedText = text.trim();
  if (normalizedText) {
    lines.push(normalizedText);
  }
  if (attachments.length > 0) {
    lines.push(`[attachments: ${attachments.map((attachment) => `${attachment.kind}:${attachment.fileName ?? attachment.fileUniqueId}`).join(', ')}]`);
  }
  return truncateSummary(lines.join(' '), 500);
}

function resolveAttachmentFileName(attachment: TelegramInboundAttachment, remoteFilePath?: string | null): string {
  const providedName = attachment.fileName ? path.basename(attachment.fileName) : '';
  const remoteName = remoteFilePath ? path.basename(remoteFilePath) : '';
  const baseCandidate = providedName || remoteName || `${attachment.kind}-${attachment.fileUniqueId}`;
  const sanitizedBase = sanitizeFileName(baseCandidate);
  const extension = extensionFromName(sanitizedBase)
    || extensionFromName(remoteName)
    || extensionFromMimeType(attachment.mimeType)
    || fallbackExtensionByKind(attachment.kind);
  if (!extension) {
    return sanitizedBase;
  }
  const withoutExtension = sanitizedBase.slice(0, sanitizedBase.length - extensionFromName(sanitizedBase).length) || `${attachment.kind}-${attachment.fileUniqueId}`;
  return truncateFileName(`${withoutExtension}${extension}`, 120);
}

function describeAttachment(attachment: TelegramInboundAttachment): string {
  switch (attachment.kind) {
    case 'photo':
      return 'photo';
    case 'document':
      return 'document';
    case 'audio':
      return 'audio file';
    case 'voice':
      return 'voice message';
    case 'video':
      return 'video';
    case 'animation':
      return 'animation';
    case 'sticker':
      return attachment.isAnimated || attachment.isVideo ? 'animated sticker' : 'sticker';
    case 'videoNote':
      return 'video note';
  }
}

function sanitizeFileName(fileName: string): string {
  const trimmed = fileName.trim().replace(/[\\/]+/g, '-');
  const sanitized = trimmed
    .replace(/[^\w.\-()+@]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/^-+/, '')
    .replace(/[.-]+$/, '');
  return sanitized || 'attachment';
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'thread';
}

function extensionFromMimeType(mimeType: string | null): string {
  if (!mimeType) return '';
  return MIME_EXTENSION_MAP[mimeType.toLowerCase()] ?? '';
}

function extensionFromName(fileName: string | null): string {
  if (!fileName) return '';
  const extension = path.extname(fileName).toLowerCase();
  return extension === '.' ? '' : extension;
}

function truncateFileName(fileName: string, maxLength: number): string {
  if (fileName.length <= maxLength) return fileName;
  const extension = extensionFromName(fileName);
  const base = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${base.slice(0, Math.max(1, maxLength - extension.length))}${extension}`;
}

function truncateSummary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function fallbackExtensionByKind(kind: TelegramAttachmentKind): string {
  return FALLBACK_EXTENSION_BY_KIND[kind] ?? '';
}
