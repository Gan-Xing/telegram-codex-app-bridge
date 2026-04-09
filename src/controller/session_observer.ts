import {
  classifyAgentOutput,
  inferToolActivityState,
  type RawExecCommandEvent,
  type TurnActivityEvent,
} from './activity.js';

export interface SessionLogCursor {
  activeTurnId: string | null;
  nextMessageIndex: number;
}

export interface SessionLogBootstrap {
  cursor: SessionLogCursor;
  events: TurnActivityEvent[];
  startedTurnId: string | null;
}

export interface SessionLogDiff {
  cursor: SessionLogCursor;
  events: TurnActivityEvent[];
  startedTurnIds: string[];
}

export interface SplitJsonlChunk {
  lines: string[];
  remainder: string;
}

interface SessionRecord {
  type: string;
  payload?: any;
}

export function splitJsonlChunk(remainder: string, chunk: string): SplitJsonlChunk {
  const text = `${remainder}${chunk}`;
  if (text.length === 0) {
    return { lines: [], remainder: '' };
  }
  const parts = text.split('\n');
  const nextRemainder = text.endsWith('\n') ? '' : parts.pop() ?? '';
  return {
    lines: parts.filter(line => line.trim().length > 0),
    remainder: nextRemainder,
  };
}

export function bootstrapSessionLog(lines: string[]): SessionLogBootstrap {
  const records = parseRecords(lines);
  let activeTurnId: string | null = null;
  let nextMessageIndex = 0;
  let events: TurnActivityEvent[] = [];

  for (const record of records) {
    const next = applySessionRecord(record, { activeTurnId, nextMessageIndex });
    if (next.startedTurnId) {
      activeTurnId = next.startedTurnId;
      nextMessageIndex = 0;
      events = [];
      continue;
    }
    if (!activeTurnId) {
      continue;
    }
    if (next.turnCompleted) {
      activeTurnId = null;
      nextMessageIndex = 0;
      events = [];
      continue;
    }
    events.push(...next.events);
    activeTurnId = next.cursor.activeTurnId;
    nextMessageIndex = next.cursor.nextMessageIndex;
  }

  return {
    cursor: { activeTurnId, nextMessageIndex },
    events,
    startedTurnId: activeTurnId,
  };
}

export function applySessionLog(lines: string[], cursor: SessionLogCursor): SessionLogDiff {
  const records = parseRecords(lines);
  let state: SessionLogCursor = { ...cursor };
  const events: TurnActivityEvent[] = [];
  const startedTurnIds: string[] = [];

  for (const record of records) {
    const next = applySessionRecord(record, state);
    if (next.startedTurnId) {
      state = {
        activeTurnId: next.startedTurnId,
        nextMessageIndex: 0,
      };
      startedTurnIds.push(next.startedTurnId);
      continue;
    }
    events.push(...next.events);
    state = next.cursor;
  }

  return {
    cursor: state,
    events,
    startedTurnIds,
  };
}

function parseRecords(lines: string[]): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as SessionRecord;
      if (parsed && typeof parsed.type === 'string') {
        records.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return records;
}

function applySessionRecord(
  record: SessionRecord,
  cursor: SessionLogCursor,
): {
  cursor: SessionLogCursor;
  events: TurnActivityEvent[];
  startedTurnId: string | null;
  turnCompleted: boolean;
} {
  const { type, payload } = record;
  if (type === 'event_msg' && payload?.type === 'task_started' && typeof payload.turn_id === 'string') {
    return {
      cursor: { activeTurnId: payload.turn_id, nextMessageIndex: 0 },
      events: [],
      startedTurnId: payload.turn_id,
      turnCompleted: false,
    };
  }

  const activeTurnId = cursor.activeTurnId;
  if (!activeTurnId) {
    return {
      cursor,
      events: [],
      startedTurnId: null,
      turnCompleted: false,
    };
  }

  if (type === 'event_msg' && payload?.type === 'agent_message' && typeof payload.message === 'string') {
    const itemId = buildSessionItemId(activeTurnId, cursor.nextMessageIndex + 1);
    const phase = typeof payload.phase === 'string' ? payload.phase : null;
    const outputKind = classifyAgentOutput(phase, true);
    return {
      cursor: {
        activeTurnId,
        nextMessageIndex: cursor.nextMessageIndex + 1,
      },
      events: [
        {
          kind: 'agent_message_started',
          turnId: activeTurnId,
          itemId,
          phase,
          outputKind: classifyAgentOutput(phase, false),
        },
        {
          kind: 'agent_message_delta',
          turnId: activeTurnId,
          itemId,
          delta: payload.message,
          outputKind: classifyAgentOutput(phase, false),
        },
        {
          kind: 'agent_message_completed',
          turnId: activeTurnId,
          itemId,
          phase,
          text: payload.message,
          outputKind,
        },
      ],
      startedTurnId: null,
      turnCompleted: false,
    };
  }

  if (type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') {
    const text = payload.message.trim();
    if (!text) {
      return { cursor, events: [], startedTurnId: null, turnCompleted: false };
    }
    return {
      cursor,
      events: [{
        kind: 'user_message',
        turnId: activeTurnId,
        text,
      }],
      startedTurnId: null,
      turnCompleted: false,
    };
  }

  if (type === 'response_item' && payload?.type === 'function_call' && payload?.name === 'exec_command') {
    const exec = createExecStartEvent(activeTurnId, payload);
    if (!exec) {
      return { cursor, events: [], startedTurnId: null, turnCompleted: false };
    }
    return {
      cursor,
      events: [{
        kind: 'tool_started',
        turnId: activeTurnId,
        exec,
        state: inferToolActivityState(exec),
      }],
      startedTurnId: null,
      turnCompleted: false,
    };
  }

  if (type === 'event_msg' && payload?.type === 'exec_command_end' && payload?.turn_id === activeTurnId) {
    const exec = createExecEndEvent(payload);
    if (!exec) {
      return { cursor, events: [], startedTurnId: null, turnCompleted: false };
    }
    return {
      cursor,
      events: [{
        kind: 'tool_completed',
        turnId: activeTurnId,
        exec,
        state: inferToolActivityState(exec),
      }],
      startedTurnId: null,
      turnCompleted: false,
    };
  }

  if (type === 'event_msg' && payload?.type === 'task_complete' && payload?.turn_id === activeTurnId) {
    return {
      cursor: { activeTurnId: null, nextMessageIndex: 0 },
      events: [{
        kind: 'turn_completed',
        turnId: activeTurnId,
        state: 'completed',
      }],
      startedTurnId: null,
      turnCompleted: true,
    };
  }

  return {
    cursor,
    events: [],
    startedTurnId: null,
    turnCompleted: false,
  };
}

function buildSessionItemId(turnId: string, index: number): string {
  return `${turnId}:session:${index}`;
}

function createExecStartEvent(turnId: string, payload: any): RawExecCommandEvent | null {
  const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
  if (!callId) {
    return null;
  }
  let args: any = null;
  if (typeof payload.arguments === 'string') {
    try {
      args = JSON.parse(payload.arguments);
    } catch {
      args = null;
    }
  }
  const commandText = typeof args?.cmd === 'string' ? args.cmd : null;
  const cwd = typeof args?.workdir === 'string' ? args.workdir : null;
  return {
    callId,
    turnId,
    command: commandText ? ['/bin/bash', '-lc', commandText] : [],
    cwd,
    parsedCmd: [],
  };
}

function createExecEndEvent(payload: any): RawExecCommandEvent | null {
  const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
  if (!callId || !turnId) {
    return null;
  }
  return {
    callId,
    turnId,
    command: Array.isArray(payload.command) ? payload.command.map((entry: unknown) => String(entry)) : [],
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
    parsedCmd: Array.isArray(payload.parsed_cmd) ? payload.parsed_cmd : [],
  };
}
