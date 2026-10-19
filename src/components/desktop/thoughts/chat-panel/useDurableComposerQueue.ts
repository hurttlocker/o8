'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';
import type { ComposerQueuePayload, ComposerQueueTarget, QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';

const EMPTY_QUEUE: QueuedComposerSendRecord[] = [];

export function useDurableComposerQueue(target: ComposerQueueTarget | null, busy: boolean) {
  const [saved, setSaved] = useState<{ key: string; items: QueuedComposerSendRecord[] } | null>(null);
  const [removing, setRemoving] = useState<Set<number>>(new Set());
  const removingRef = useRef(new Set<number>());
  const [error, setError] = useState<string | null>(null);
  const scopeKey = target ? JSON.stringify(target) : '';
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const targetRef = useRef(target); targetRef.current = target;
  const revisionRef = useRef(0);
  const mutations = useRef(new Map<string, Promise<unknown>>());
  const serialize = useCallback(<T,>(key: string, action: () => Promise<T>): Promise<T> => {
    const pending = (mutations.current.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    mutations.current.set(key, pending);
    void pending.finally(() => { if (mutations.current.get(key) === pending) mutations.current.delete(key); }).catch(() => {});
    return pending;
  }, []);
  const enqueueRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const refresh = useCallback(async () => {
    const snapshot = targetRef.current;
    if (!snapshot) return;
    const key = JSON.stringify(snapshot);
    const revision = ++revisionRef.current;
    try {
      const response = await fetch(`/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(snapshot.repoPath)}&threadId=${encodeURIComponent(snapshot.threadId)}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load queued messages.');
      if (scopeRef.current === key && revision === revisionRef.current) { setSaved({ key, items: body.items }); setError(null); }
    } catch (cause) {
      if (scopeRef.current === key && revision === revisionRef.current) setError(cause instanceof Error ? cause.message : 'Unable to load queued messages.');
    }
  }, []);
  useSharedDesktopWs(undefined, { onRealtimeEvent: event => {
    const mutation = event.channel === 'mutation' ? (event.data as { mutation?: RealtimeMutationRecord }).mutation : undefined;
    if (mutation?.action === 'composer-queue' && mutation.surfaceId === targetRef.current?.threadId) void refresh();
  } });
  useEffect(() => {
    setError(null);
    void refresh();
    window.addEventListener('o8:lifecycle-reconcile', refresh);
    return () => { window.removeEventListener('o8:lifecycle-reconcile', refresh); };
  }, [scopeKey, busy, refresh]);
  const enqueue = useCallback(async (payload: ComposerQueuePayload, idempotencyKey?: string) => {
    const snapshot = targetRef.current;
    if (!snapshot) throw new Error('Wait for this chat to be saved before using Send next.');
    return serialize(JSON.stringify(snapshot), async () => {
      const fingerprint = JSON.stringify({ ...snapshot, payload });
      if (enqueueRef.current?.fingerprint !== fingerprint) enqueueRef.current = { fingerprint, id: `queue-${crypto.randomUUID()}` };
      const response = await fetch('/api/orchestrator/composer-queue', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...snapshot, id: idempotencyKey ?? enqueueRef.current.id, intent: 'send-next', payload }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to save the queued message.');
      enqueueRef.current = null;
      if (scopeRef.current === JSON.stringify(snapshot)) { setError(null); await refresh(); }
      return body.item as QueuedComposerSendRecord;
    });
  }, [refresh, serialize]);
  const items = saved?.key === scopeKey ? saved.items : EMPTY_QUEUE;
  const cancelRecord = useCallback(async (item: QueuedComposerSendRecord) => {
    const sequence = item.sequence;
    if (removingRef.current.has(sequence)) return false;
    const key = JSON.stringify({ repoPath: item.repoPath, threadId: item.threadId });
    removingRef.current.add(sequence); setRemoving(new Set(removingRef.current));
    try {
      const response = await fetch('/api/orchestrator/composer-queue', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: item.repoPath, threadId: item.threadId, id: item.id }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to remove the queued message.');
      if (scopeRef.current === JSON.stringify({ repoPath: item.repoPath, threadId: item.threadId })) { setError(null); await refresh(); }
      return true;
    } catch (cause) {
      if (scopeRef.current === key) setError(cause instanceof Error ? cause.message : 'Unable to remove the queued message.');
      return false;
    } finally { removingRef.current.delete(sequence); setRemoving(new Set(removingRef.current)); }
  }, [refresh]);
  const cancel = useCallback(async (sequence: number) => {
    const item = items.find(row => row.sequence === sequence);
    return item ? cancelRecord(item) : false;
  }, [items, cancelRecord]);
  const cancelVoiceFollowups = useCallback(async () => {
    const snapshot = targetRef.current;
    if (!snapshot) return 'The shared follow-up queue is unavailable; cancellation is not confirmed.';
    return serialize(JSON.stringify(snapshot), async () => {
      try {
        // Read after prior saves settle, including saves whose response was lost.
        const response = await fetch(`/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(snapshot.repoPath)}&threadId=${encodeURIComponent(snapshot.threadId)}`, { cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw new Error('Unable to confirm queued messages.');
        const voiceItems = (body.items as QueuedComposerSendRecord[]).filter(item => item.payload.afterTaskId);
        if (!voiceItems.length) return 'No pending voice follow-up was found. Already submitted work is unchanged.';
        const removed = await Promise.all(voiceItems.map(cancelRecord));
        return removed.every(Boolean) ? 'Queued voice follow-up canceled before submission. The running task is unchanged.'
          : 'Cancellation is not confirmed for every follow-up. Inspect the conversation; work may already have been submitted.';
      } catch { return 'Unable to confirm cancellation. Inspect the queued messages in this conversation.'; }
    });
  }, [cancelRecord, serialize]);
  return { items, enqueue, cancel, cancelVoiceFollowups, error, removing, ready: !target || saved?.key === scopeKey };
}
