const ROW_LAST_VISITED_KEY = 'o8:row-last-visited';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface RowReadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type RowReadState = Record<string, number>;

function defaultStorage(): RowReadStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function readState(storage: RowReadStorage | null): RowReadState {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(ROW_LAST_VISITED_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => (
      typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )));
  } catch {
    return {};
  }
}

export function getLastVisited(rowKey: string, storage = defaultStorage()): number | null {
  return readState(storage)[rowKey] ?? null;
}

export function pruneOlderThan(
  state: RowReadState,
  cutoff = Date.now() - THIRTY_DAYS_MS,
): RowReadState {
  return Object.fromEntries(Object.entries(state).filter(([, visitedAt]) => visitedAt >= cutoff));
}

export function markVisited(
  rowKey: string,
  visitedAt = Date.now(),
  storage = defaultStorage(),
): void {
  if (!storage || !rowKey) return;
  const next = pruneOlderThan({ ...readState(storage), [rowKey]: visitedAt }, visitedAt - THIRTY_DAYS_MS);
  try {
    storage.setItem(ROW_LAST_VISITED_KEY, JSON.stringify(next));
  } catch {
    // Per-device affordance only; storage denial must not block navigation.
  }
}
