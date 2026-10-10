import type { TerminalTab } from './types';

export type TerminalCloseRequest = { tab: TerminalTab; count: number; resolve: (confirmed: boolean) => void };
let listener: ((request: TerminalCloseRequest) => void) | null = null;
let pending: Promise<boolean> | null = null;

export function subscribeTerminalCloseConfirm(next: (request: TerminalCloseRequest) => void): () => void {
  listener = next;
  return () => { if (listener === next) listener = null; };
}

export function confirmTerminalClose(tab: TerminalTab, count = 1): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  if (!listener) return Promise.resolve(false);
  pending = new Promise<boolean>((resolve) => listener?.({ tab, count, resolve }));
  return pending.finally(() => { pending = null; });
}
