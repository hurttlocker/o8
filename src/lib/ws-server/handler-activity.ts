import { performance } from 'node:perf_hooks';

// Fixed labels only: never store request bodies, repository names or arguments.
export type WsHealthHandler = 'dispatch' | 'merge' | 'worktree-reaper' | 'ws-message';
const active = new Map<WsHealthHandler, number>();
const completed: Array<{ name: WsHealthHandler; endedAt: number }> = [];

/** Retain a small overlap history: a synchronous handler can finish before a late timer fires. */
export async function withWsHealthHandler<T>(name: WsHealthHandler, operation: () => Promise<T>): Promise<T> {
  active.set(name, (active.get(name) ?? 0) + 1);
  try { return await operation(); }
  finally {
    const remaining = active.get(name)! - 1;
    if (remaining) active.set(name, remaining);
    else active.delete(name);
    completed.push({ name, endedAt: performance.now() });
    if (completed.length > 64) completed.shift();
  }
}

export function wsInFlightHandlers(): WsHealthHandler[] { return [...active.keys()].sort(); }

export function wsHandlersSince(since: number): WsHealthHandler[] {
  while (completed.length && completed[0]!.endedAt < since) completed.shift();
  return [...new Set([...active.keys(), ...completed.map((entry) => entry.name)])].sort();
}

/** Preserve a public entry point's arguments and result while tracking its full async lifetime. */
export function observeWsHealthHandler<Args extends unknown[], Result>(
  name: WsHealthHandler, handler: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args) => withWsHealthHandler(name, () => handler(...args));
}
