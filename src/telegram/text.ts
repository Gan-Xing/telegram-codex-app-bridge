export const TELEGRAM_MESSAGE_LIMIT = 4000;
export const TELEGRAM_STREAM_MESSAGE_LIMIT = 1200;
export const TELEGRAM_DRAFT_LIMIT = 4000;

export function sanitizeTelegramPreview(text: string): string {
  if (!text.trim()) return 'Working...';
  return text.length > TELEGRAM_MESSAGE_LIMIT
    ? `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 3)}...`
    : text;
}

export function chunkTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT, fallbackText = 'Completed.'): string[] {
  const source = text.trim() ? text : fallbackText;
  if (!source) {
    return [];
  }
  if (source.length <= limit) {
    return [source];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < source.length) {
    const remaining = source.length - start;
    if (remaining <= limit) {
      chunks.push(source.slice(start));
      break;
    }

    const tentativeEnd = start + limit;
    const window = source.slice(start, tentativeEnd);
    const splitAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    const end = splitAt >= Math.floor(limit / 2)
      ? start + splitAt + 1
      : tentativeEnd;

    chunks.push(source.slice(start, end));
    start = end;
  }

  return chunks.filter(chunk => chunk.length > 0);
}

export function chunkTelegramStreamMessage(text: string, limit = TELEGRAM_STREAM_MESSAGE_LIMIT): string[] {
  return chunkTelegramMessage(text, limit, '');
}

export function clipTelegramDraftMessage(text: string, fallbackText = 'Thinking...'): string {
  const source = text.trim() ? text : fallbackText;
  if (source.length <= TELEGRAM_DRAFT_LIMIT) {
    return source;
  }
  return `${source.slice(0, TELEGRAM_DRAFT_LIMIT - 1)}…`;
}
