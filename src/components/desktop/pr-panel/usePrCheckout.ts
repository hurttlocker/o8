'use client';

import { useCallback, useSyncExternalStore } from 'react';

interface CheckoutState { busy: boolean; uncertain: boolean; error: string | null; workspace?: { path: string; branch: string; commitSha: string } }
const idle: CheckoutState = { busy: false, uncertain: false, error: null };
const states = new Map<string, CheckoutState>();
const listeners = new Map<string, Set<() => void>>();
function read(key: string) { return states.get(key) || idle; }
function update(key: string, state: CheckoutState) {
  states.set(key, state);
  if (states.size > 40) { const oldest = [...states.keys()].find((candidate) => candidate !== key && !read(candidate).busy && !read(candidate).uncertain && !listeners.get(candidate)?.size); if (oldest) states.delete(oldest); }
  listeners.get(key)?.forEach((listener) => listener());
}
export function usePrCheckout(repo: string | null | undefined, number: number, repoPath?: string | null) {
  const key = `${repo || ''}:${number}:${repoPath || ''}`;
  const subscribe = useCallback((listener: () => void) => { const group = listeners.get(key) || new Set<() => void>(); group.add(listener); listeners.set(key, group); return () => { group.delete(listener); if (!group.size) listeners.delete(key); }; }, [key]);
  const snapshot = useCallback(() => read(key), [key]);
  const state = useSyncExternalStore(subscribe, snapshot, () => idle);
  const checkout = useCallback(async (commitSha: string) => {
    const previous = read(key); if (!repo || !repoPath || !commitSha || previous.busy || previous.uncertain) return;
    update(key, { ...previous, busy: true, error: null });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch(`/api/panel/prs/${number}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, repoPath, commitSha }), signal: controller.signal });
      const result = await response.json() as { ok?: boolean; error?: string; workspace?: CheckoutState['workspace'] };
      if (!response.ok || result.ok !== true || !result.workspace?.path || result.workspace.commitSha !== commitSha) {
        update(key, { ...previous, busy: false, uncertain: response.status >= 500 || Boolean(result.workspace), error: result.error || 'Checkout could not be confirmed.' }); return;
      }
      update(key, { ...idle, workspace: result.workspace });
    } catch { update(key, { ...previous, busy: false, uncertain: true, error: 'Checkout could not be confirmed. Check workspaces before another attempt.' }); }
    finally { clearTimeout(timer); }
  }, [key, repo, number, repoPath]);
  return { ...state, checkout, acknowledge: () => update(key, { ...read(key), uncertain: false, error: null }) };
}
