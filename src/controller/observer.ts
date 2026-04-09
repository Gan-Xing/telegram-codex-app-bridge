import type { AppThreadSnapshot, AppTurnItemSnapshot, AppTurnSnapshot } from '../types.js';
import { classifyAgentOutput, type TurnActivityEvent } from './activity.js';

export interface ObservedTurnCursor {
  turnId: string;
  itemTexts: Record<string, string>;
  completedItemIds: string[];
}

export interface ObservedTurnDiff {
  nextCursor: ObservedTurnCursor;
  events: TurnActivityEvent[];
  waitingOnApproval: boolean;
  completed: boolean;
}

export function findLiveTurn(snapshot: AppThreadSnapshot): AppTurnSnapshot | null {
  for (let index = snapshot.turns.length - 1; index >= 0; index -= 1) {
    const turn = snapshot.turns[index]!;
    if (turn.status === 'inProgress') {
      return turn;
    }
  }
  return null;
}

export function findLatestTurn(snapshot: AppThreadSnapshot): AppTurnSnapshot | null {
  return snapshot.turns.at(-1) ?? null;
}

export function diffObservedTurn(
  cursor: ObservedTurnCursor | null,
  turn: AppTurnSnapshot,
  waitingOnApproval: boolean,
): ObservedTurnDiff {
  const baseCursor: ObservedTurnCursor = cursor && cursor.turnId === turn.turnId
    ? {
        turnId: cursor.turnId,
        itemTexts: { ...cursor.itemTexts },
        completedItemIds: [...cursor.completedItemIds],
      }
    : {
        turnId: turn.turnId,
        itemTexts: {},
        completedItemIds: [],
      };
  const completedIds = new Set(baseCursor.completedItemIds);
  const events: TurnActivityEvent[] = [];
  const agentItems = turn.items.filter(isRelayableAgentItem);

  for (const item of agentItems) {
    const previousText = baseCursor.itemTexts[item.itemId];
    const nextText = item.text || '';
    if (previousText === undefined) {
      events.push({
        kind: 'agent_message_started',
        turnId: turn.turnId,
        itemId: item.itemId,
        phase: item.phase,
        outputKind: classifyAgentOutput(item.phase, false),
      });
      if (nextText) {
        events.push({
          kind: 'agent_message_delta',
          turnId: turn.turnId,
          itemId: item.itemId,
          delta: nextText,
          outputKind: classifyAgentOutput(item.phase, false),
        });
      }
    } else if (nextText.length > previousText.length) {
      events.push({
        kind: 'agent_message_delta',
        turnId: turn.turnId,
        itemId: item.itemId,
        delta: nextText.slice(previousText.length),
        outputKind: classifyAgentOutput(item.phase, false),
      });
    }
    baseCursor.itemTexts[item.itemId] = nextText;
  }

  for (let index = 0; index < agentItems.length; index += 1) {
    const item = agentItems[index]!;
    const itemIsCompleted = turn.status !== 'inProgress' || index < agentItems.length - 1;
    if (!itemIsCompleted || completedIds.has(item.itemId)) {
      continue;
    }
    completedIds.add(item.itemId);
    events.push({
      kind: 'agent_message_completed',
      turnId: turn.turnId,
      itemId: item.itemId,
      phase: item.phase,
      text: baseCursor.itemTexts[item.itemId] ?? item.text ?? null,
      outputKind: classifyAgentOutput(item.phase, true),
    });
  }

  return {
    nextCursor: {
      turnId: baseCursor.turnId,
      itemTexts: baseCursor.itemTexts,
      completedItemIds: [...completedIds],
    },
    events,
    waitingOnApproval,
    completed: turn.status !== 'inProgress',
  };
}

function isRelayableAgentItem(item: AppTurnItemSnapshot): boolean {
  const normalizedType = item.type.toLowerCase();
  return normalizedType === 'agentmessage' || normalizedType === 'assistantmessage';
}
