import type { JsonRpcNotification } from '../codex_app/client.js';

export interface RawExecCommandEvent {
  callId: string;
  turnId: string;
  command: string[];
  cwd: string | null;
  parsedCmd: any[];
}

export type TurnActivityState =
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'running_command'
  | 'approval_waiting'
  | 'completed';

export type TurnOutputKind = 'commentary' | 'final_answer' | 'tool_summary' | 'error';

export type TurnActivityEvent =
  | {
      kind: 'agent_message_started';
      turnId: string;
      itemId: string;
      phase: string | null;
      outputKind: TurnOutputKind;
    }
  | {
      kind: 'agent_message_delta';
      turnId: string;
      itemId: string;
      delta: string;
      outputKind: TurnOutputKind;
    }
  | {
      kind: 'agent_message_completed';
      turnId: string;
      itemId: string;
      phase: string | null;
      text: string | null;
      outputKind: TurnOutputKind;
    }
  | {
      kind: 'reasoning_started';
      turnId: string;
      state: 'thinking';
    }
  | {
      kind: 'reasoning_completed';
      turnId: string;
      state: 'thinking';
    }
  | {
      kind: 'tool_started';
      turnId: string;
      exec: RawExecCommandEvent;
      state: TurnActivityState;
    }
  | {
      kind: 'tool_completed';
      turnId: string;
      exec: RawExecCommandEvent;
      state: TurnActivityState;
    }
  | {
      kind: 'turn_completed';
      turnId: string;
      state: 'completed';
    };

export function normalizeTurnActivityEvent(notification: JsonRpcNotification): TurnActivityEvent | null {
  switch (notification.method) {
    case 'item/started':
      return normalizeStartedEvent(notification.params);
    case 'item/agentMessage/delta':
      return normalizeAgentDeltaEvent(notification.params);
    case 'item/completed':
      return normalizeCompletedEvent(notification.params);
    case 'codex/event/exec_command_begin':
      return normalizeToolEvent(notification.params, 'tool_started');
    case 'codex/event/exec_command_end':
      return normalizeToolEvent(notification.params, 'tool_completed');
    case 'turn/completed': {
      const turnId = extractTurnId(notification.params);
      if (!turnId) return null;
      return {
        kind: 'turn_completed',
        turnId,
        state: 'completed',
      };
    }
    default:
      return null;
  }
}

function normalizeStartedEvent(params: any): TurnActivityEvent | null {
  const turnId = extractTurnId(params);
  if (!turnId) return null;
  const item = params?.item;
  const itemType = normalizeEventItemType(item);
  if (itemType === 'reasoning') {
    return {
      kind: 'reasoning_started',
      turnId,
      state: 'thinking',
    };
  }
  if (itemType !== 'agentmessage' && itemType !== 'assistantmessage') {
    return null;
  }
  const itemId = extractItemId(item);
  if (!itemId) return null;
  const phase = extractAgentPhase(item);
  return {
    kind: 'agent_message_started',
    turnId,
    itemId,
    phase,
    outputKind: classifyAgentOutput(phase, false),
  };
}

function normalizeAgentDeltaEvent(params: any): TurnActivityEvent | null {
  const turnId = extractTurnId(params);
  const delta = extractAgentDeltaText(params);
  const itemId = extractItemId(params);
  if (!turnId || !delta || !itemId) {
    return null;
  }
  const phase = extractAgentPhase(params);
  return {
    kind: 'agent_message_delta',
    turnId,
    itemId,
    delta,
    outputKind: classifyAgentOutput(phase, false),
  };
}

function normalizeCompletedEvent(params: any): TurnActivityEvent | null {
  const turnId = extractTurnId(params);
  if (!turnId) return null;
  const item = params?.item;
  const itemType = normalizeEventItemType(item);
  if (itemType === 'reasoning') {
    return {
      kind: 'reasoning_completed',
      turnId,
      state: 'thinking',
    };
  }
  if (itemType !== 'agentmessage' && itemType !== 'assistantmessage') {
    return null;
  }
  const itemId = extractItemId(item);
  if (!itemId) return null;
  const phase = extractAgentPhase(item);
  return {
    kind: 'agent_message_completed',
    turnId,
    itemId,
    phase,
    text: extractCompletedAgentText(params),
    outputKind: classifyAgentOutput(phase, true),
  };
}

function normalizeToolEvent(
  params: any,
  kind: 'tool_started' | 'tool_completed',
): TurnActivityEvent | null {
  const exec = extractRawExecCommandEvent(params);
  if (!exec) {
    return null;
  }
  return {
    kind,
    turnId: exec.turnId,
    exec,
    state: inferToolActivityState(exec),
  };
}

export function classifyAgentOutput(phase: string | null, completed: boolean): TurnOutputKind {
  if (!phase) {
    return completed ? 'final_answer' : 'commentary';
  }
  const normalized = phase.replace(/[^a-z]/gi, '').toLowerCase();
  if (
    normalized === 'final'
    || normalized === 'answer'
    || normalized === 'response'
    || normalized === 'finalanswer'
    || normalized === 'finalresponse'
  ) {
    return 'final_answer';
  }
  return 'commentary';
}

export function inferToolActivityState(event: RawExecCommandEvent): TurnActivityState {
  const parsedTypes = (event.parsedCmd ?? [])
    .map((entry: any) => (typeof entry?.type === 'string' ? entry.type : ''))
    .filter(Boolean);
  if (parsedTypes.includes('search')) {
    return 'searching';
  }
  if (parsedTypes.includes('read') || parsedTypes.includes('list_files')) {
    return 'reading';
  }
  if (parsedTypes.some(type => ['write', 'edit', 'apply_patch', 'move', 'copy', 'delete', 'mkdir'].includes(type))) {
    return 'editing';
  }
  return 'running_command';
}

function extractRawExecCommandEvent(params: any): RawExecCommandEvent | null {
  const msg = params?.msg;
  if (!msg || typeof msg !== 'object') {
    return null;
  }
  const callId = typeof msg.call_id === 'string' ? msg.call_id : null;
  const turnId = typeof msg.turn_id === 'string' ? msg.turn_id : null;
  if (!callId || !turnId) {
    return null;
  }
  return {
    callId,
    turnId,
    command: Array.isArray(msg.command) ? msg.command.map((entry: unknown) => String(entry)) : [],
    cwd: msg.cwd ? String(msg.cwd) : null,
    parsedCmd: Array.isArray(msg.parsed_cmd) ? msg.parsed_cmd : [],
  };
}

function extractTurnId(params: any): string | null {
  const candidates = [
    params?.turnId,
    params?.turn_id,
    params?.turn?.id,
    params?.turn?.turnId,
    params?.item?.turnId,
    params?.item?.turn_id,
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
      return String(candidate);
    }
  }
  return null;
}

function extractItemId(value: any): string | null {
  const candidates = [
    value?.itemId,
    value?.item_id,
    value?.id,
    value?.item?.id,
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
      return String(candidate);
    }
  }
  return null;
}

function extractAgentPhase(value: any): string | null {
  const phase = value?.phase ?? value?.item?.phase ?? null;
  return typeof phase === 'string' && phase.trim() ? phase : null;
}

function extractAgentDeltaText(params: any): string | null {
  const candidates = [
    params?.delta,
    params?.textDelta,
    params?.contentDelta,
    params?.text,
  ];
  for (const candidate of candidates) {
    const text = extractTextCandidate(candidate);
    if (text) {
      return text;
    }
  }
  return null;
}

function extractCompletedAgentText(params: any): string | null {
  const itemType = normalizeEventItemType(params?.item ?? params);
  if (itemType !== 'agentmessage' && itemType !== 'assistantmessage') {
    return null;
  }
  const item = params?.item ?? params;
  const directText = extractTextCandidate(item?.text)
    ?? extractTextCandidate(item?.content)
    ?? extractTextCandidate(item?.value);
  if (directText !== null) {
    return directText;
  }
  return '';
}

function normalizeEventItemType(value: any): string | null {
  const raw = value?.type ?? value?.itemType ?? value?.item_type ?? value?.kind;
  if (typeof raw !== 'string') {
    return null;
  }
  return raw.replace(/[^a-z]/gi, '').toLowerCase();
}

function extractTextCandidate(value: any): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const key of ['text', 'delta', 'content', 'value']) {
    const candidate = value[key];
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  for (const key of ['parts', 'segments', 'content']) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) {
      continue;
    }
    const text = candidate
      .map((entry) => extractTextCandidate(entry))
      .filter((entry): entry is string => entry !== null)
      .join('');
    if (text) {
      return text;
    }
  }
  return null;
}
