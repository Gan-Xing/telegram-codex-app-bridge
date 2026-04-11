export interface ClaudeSystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  model?: string;
  permissionMode?: string;
  claude_code_version?: string;
}

export interface ClaudeTextContent {
  type: 'text';
  text?: string;
}

export interface ClaudeToolUseContent {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface ClaudeToolResultContent {
  type: 'tool_result';
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ClaudeAssistantEvent {
  type: 'assistant';
  session_id?: string;
  message?: {
    id?: string;
    role?: string;
    content?: Array<ClaudeTextContent | ClaudeToolUseContent | Record<string, unknown>>;
  };
}

export interface ClaudeUserEvent {
  type: 'user';
  session_id?: string;
  message?: {
    id?: string;
    role?: string;
    content?: Array<ClaudeToolResultContent | Record<string, unknown>>;
  };
}

export interface ClaudeResultEvent {
  type: 'result';
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  error?: string;
}

export interface ClaudeRateLimitEvent {
  type: 'rate_limit_event';
  session_id?: string;
}

export interface ClaudeStreamTextDeltaEvent {
  type: 'stream_event';
  session_id?: string;
  event?: {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
    };
  };
}

export type ClaudeStreamEvent =
  | ClaudeSystemInitEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudeRateLimitEvent
  | ClaudeStreamTextDeltaEvent;

export function parseClaudeStreamLine(line: string): ClaudeStreamEvent | null {
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
  if (type !== 'system'
    && type !== 'assistant'
    && type !== 'user'
    && type !== 'result'
    && type !== 'rate_limit_event'
    && type !== 'stream_event') {
    return null;
  }
  return parsed as ClaudeStreamEvent;
}

export function mapClaudeToolToParsedCmdType(toolName: string | null | undefined): string | null {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  switch (normalized) {
    case 'bash':
    case 'shell':
      return 'run';
    case 'read':
    case 'glob':
    case 'grep':
      return normalized === 'grep' ? 'search' : 'read';
    case 'edit':
    case 'multiedit':
    case 'write':
    case 'notebookedit':
      return 'edit';
    case 'websearch':
    case 'webfetch':
      return 'search';
    default:
      return 'run';
  }
}
