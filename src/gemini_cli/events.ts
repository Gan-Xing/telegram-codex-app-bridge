export interface GeminiInitEvent {
  type: 'init';
  timestamp?: string;
  session_id?: string;
  model?: string;
}

export interface GeminiMessageEvent {
  type: 'message';
  timestamp?: string;
  role?: string;
  content?: string;
  delta?: boolean;
}

export interface GeminiToolUseEvent {
  type: 'tool_use';
  timestamp?: string;
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiToolResultEvent {
  type: 'tool_result';
  timestamp?: string;
  tool_id?: string;
  status?: string;
  output?: unknown;
}

export interface GeminiResultEvent {
  type: 'result';
  timestamp?: string;
  status?: string;
  error?: unknown;
  stats?: Record<string, unknown>;
}

export interface GeminiErrorEvent {
  type: 'error';
  timestamp?: string;
  message?: string;
  code?: string | number;
}

export type GeminiStreamEvent =
  | GeminiInitEvent
  | GeminiMessageEvent
  | GeminiToolUseEvent
  | GeminiToolResultEvent
  | GeminiResultEvent
  | GeminiErrorEvent;

export function parseGeminiStreamLine(line: string): GeminiStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const type = (parsed as { type?: unknown }).type;
  if (type !== 'init'
    && type !== 'message'
    && type !== 'tool_use'
    && type !== 'tool_result'
    && type !== 'result'
    && type !== 'error') {
    return null;
  }
  return parsed as GeminiStreamEvent;
}

export function mapGeminiToolToParsedCmdType(toolName: string | null | undefined): string | null {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  switch (normalized) {
    case 'read_file':
    case 'list_dir':
    case 'find_files':
    case 'search_files':
      return normalized === 'search_files' ? 'search' : 'read';
    case 'edit_file':
    case 'write_file':
      return 'edit';
    case 'web_search':
    case 'web_fetch':
      return 'search';
    default:
      return 'run';
  }
}
