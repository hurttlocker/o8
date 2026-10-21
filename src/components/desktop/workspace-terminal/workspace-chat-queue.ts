'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { PendingSteer } from '@/components/desktop/thoughts/chat-panel/PendingSteerCard';

export type WorkspaceSendOutcome = 'accepted' | 'queued' | 'failed' | 'unconfirmed';
export interface WorkspaceQueuedSteer extends PendingSteer {
  mutationId: string;
  status: 'queued' | 'sending' | 'unconfirmed';
}
interface QueueState { items: WorkspaceQueuedSteer[]; paused: boolean; retentionWarning?: string }
const EMPTY: QueueState = { items: [], paused: false };
const states = new Map<string, QueueState>();
const listeners = new Set<() => void>();
const STORAGE_KEY = 'o8:workspace-queue:v1';
const MAX_QUEUED = 64;
let loaded = false;

function read(scope: string): QueueState {
  if (!loaded && typeof window !== 'undefined') {
    loaded = true;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      const rows: unknown = raw && raw.length <= 2_000_000 ? JSON.parse(raw) : [];
      if (Array.isArray(rows)) for (const row of rows.slice(-32)) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length > 4096 || !Array.isArray(row[1])) continue;
        const items = row[1].filter((item): item is WorkspaceQueuedSteer => item && typeof item.id === 'string'
          && typeof item.text === 'string' && typeof item.mutationId === 'string'
          && ['queued', 'sending', 'unconfirmed'].includes(item.status)).slice(0, MAX_QUEUED)
          .map(item => ({ ...item, status: item.status === 'sending' ? 'unconfirmed' as const : item.status }));
        states.set(row[0], { items, paused: true });
      }
    } catch { /* Memory retention still works when browser storage is unavailable. */ }
  }
  return states.get(scope) ?? EMPTY;
}
function write(scope: string, next: QueueState) {
  if (next.items.length) states.set(scope, next); else states.delete(scope);
  while (states.size > 32) states.delete(states.keys().next().value!);
  let failed = false;
  try {
    const raw = JSON.stringify([...states].map(([key, value]) => [key, value.items]));
    if (raw.length > 2_000_000) throw new Error('Queue storage limit');
    sessionStorage.setItem(STORAGE_KEY, raw);
  } catch { failed = true; try { sessionStorage.removeItem(STORAGE_KEY); } catch {} }
  for (const [key, value] of states) states.set(key, { ...value, retentionWarning: failed ? 'Browser storage is unavailable. Keep this tab open to retain queued messages.' : undefined });
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Delivery removes one acknowledged intent by identity, never merely the current first row. */
export function useWorkspaceSteerQueue(scope: string, canSend: boolean, send: (item: WorkspaceQueuedSteer) => Promise<WorkspaceSendOutcome>) {
  const snapshot = useCallback(() => read(scope), [scope]);
  const state = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const update = useCallback((fn: (current: QueueState) => QueueState) => write(scope, fn(read(scope))), [scope]);
  const enqueue = useCallback((text: string) => {
    const current = read(scope);
    if (!text.trim() || current.items.length >= MAX_QUEUED) return false;
    const id = crypto.randomUUID();
    write(scope, { ...current, items: [...current.items, { id, mutationId: id, text: text.trim(), status: 'queued' }] });
    return true;
  }, [scope]);
  useEffect(() => () => { const current = read(scope); if (current.items.length) write(scope, { ...current, paused: true }); }, [scope]);
  useEffect(() => {
    const head = state.items[0];
    if (!canSend || state.paused || !head || head.status !== 'queued') return;
    // Synchronous store latch also protects Strict Mode/repeated effects.
    if (read(scope).items.find(item => item.id === head.id)?.status !== 'queued') return;
    update(current => ({ ...current, items: current.items.map(item => item.id === head.id ? { ...item, status: 'sending' } : item) }));
    void Promise.resolve().then(() => send(head)).catch(() => 'unconfirmed' as const).then(outcome => {
      update(current => ({ ...current,
        paused: current.paused || outcome !== 'accepted',
        items: outcome === 'accepted' ? current.items.filter(item => item.id !== head.id)
          : current.items.map(item => item.id === head.id ? { ...item, status: outcome === 'unconfirmed' ? 'unconfirmed' : 'queued',
            mutationId: outcome === 'queued' || outcome === 'failed' ? crypto.randomUUID() : item.mutationId } : item),
      }));
    });
  }, [canSend, scope, send, state, update]);
  const remove = useCallback((id: string) => update(current => ({ ...current, items: current.items.filter(item => item.id !== id || item.status === 'sending') })), [update]);
  const edit = useCallback((id: string, text: string) => update(current => ({ ...current, items: current.items.flatMap(item => item.id === id && item.status === 'queued'
    ? text.trim() ? [{ ...item, text: text.trim(), mutationId: crypto.randomUUID() }] : [] : [item]) })), [update]);
  const resume = useCallback(() => update(current => current.items.some(item => item.status === 'unconfirmed') ? current : { ...current, paused: false }), [update]);
  const promote = useCallback((id: string) => update(current => {
    if (current.items.some(item => item.status !== 'queued')) return current;
    const target = current.items.find(item => item.id === id);
    return target ? { items: [target, ...current.items.filter(item => item.id !== id)], paused: false } : current;
  }), [update]);
  return { items: state.items, paused: state.paused, enqueue, remove, edit, resume, promote,
    notice: state.retentionWarning ?? (state.items.some(item => item.status === 'unconfirmed') ? 'Delivery unconfirmed. Check the transcript before removing or sending again.'
      : state.paused ? 'Queue paused. Resume when you are ready.' : null) };
}
export function resetWorkspaceSteerQueueForTests(clearStorage = true) {
  states.clear(); loaded = false;
  if (clearStorage) { try { sessionStorage.removeItem(STORAGE_KEY); } catch {} }
}
