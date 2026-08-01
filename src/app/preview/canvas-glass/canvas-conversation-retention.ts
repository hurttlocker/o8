import type { DockEntry } from './ui';

export const MAX_CANVAS_CONVERSATION_ENTRIES = 200;
export const MAX_CANVAS_CONVERSATIONS = 32;

export type CanvasConversationStore = Record<string, DockEntry[]>;

export function setCanvasConversation(
  previous: CanvasConversationStore,
  key: string,
  entries: DockEntry[],
): CanvasConversationStore {
  const next = { ...previous };
  delete next[key];
  if (entries.length > 0) next[key] = entries.slice(-MAX_CANVAS_CONVERSATION_ENTRIES);
  const keys = Object.keys(next);
  for (let index = 0; index < keys.length - MAX_CANVAS_CONVERSATIONS; index += 1) {
    delete next[keys[index]!];
  }
  return next;
}

export function updateCanvasConversation(
  previous: CanvasConversationStore,
  key: string,
  update: (entries: DockEntry[]) => DockEntry[],
): CanvasConversationStore {
  return setCanvasConversation(previous, key, update(previous[key] ?? []));
}

export function removeCanvasConversations(
  previous: CanvasConversationStore,
  keys: string[],
): CanvasConversationStore {
  const next = { ...previous };
  for (const key of keys) delete next[key];
  return next;
}

export function clearCanvasTurnAccumulators<T>(
  lane: string,
  turnText: Map<string, string>,
  turnTools: Map<string, T>,
): void {
  turnText.delete(lane);
  turnTools.delete(lane);
}
