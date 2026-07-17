/**
 * useReactiveQuery — TanStack Query + WebSocket event invalidation.
 *
 * Replaces polling patterns. Fetches data once, caches it, and
 * re-fetches instantly when a WebSocket event signals the data changed.
 *
 * Usage:
 *   const { data, isLoading } = useReactiveQuery({
 *     queryKey: ['lanes', 'active'],
 *     queryFn: () => fetch('/api/lanes?active=true').then(r => r.json()),
 *     wsEvents: ['lane-lifecycle'],  // invalidate on these WS channels
 *   });
 *
 * The wsEvents array maps to WebSocket channel names from ws-server.ts.
 * When any matching event arrives, the query is silently refetched in
 * the background (stale-while-revalidate pattern).
 */

import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

interface ReactiveQueryOptions<T> extends Omit<UseQueryOptions<T, Error, T, string[]>, 'queryKey' | 'queryFn'> {
  queryKey: string[];
  queryFn: () => Promise<T>;
  /** WebSocket channel names that should trigger a refetch. */
  wsEvents?: string[];
  /** Additional custom event names (window CustomEvents) that trigger refetch. */
  customEvents?: string[];
}

/**
 * Listen for WebSocket-relayed events on window.
 *
 * The DesktopWebSocketContext already dispatches events for lane-lifecycle,
 * agent-lifecycle, etc. This hook listens for a custom window event pattern:
 *   `o8:${channel}` — fired when the WS context receives a message on that channel.
 *
 * If the WS context doesn't dispatch window events yet, we also support
 * a global invalidation bus via `o8:invalidate` with detail.queryKey.
 */
export function useReactiveQuery<T>(options: ReactiveQueryOptions<T>) {
  const { queryKey, queryFn, wsEvents, customEvents, ...queryOptions } = options;
  const queryClient = useQueryClient();
  const mountedRef = useRef(true);

  const result = useQuery<T, Error, T, string[]>({
    queryKey,
    queryFn,
    ...queryOptions,
  });

  // Stabilize the effect by CONTENT, not array identity. Callers pass inline
  // array literals (`['lanes','active']`, `wsEvents: ['lane-lifecycle']`) that get
  // a fresh reference every render — which otherwise tore down and re-added EVERY
  // window listener on every render of every consumer (pure waste fleet-wide).
  // The live queryKey rides a ref into the handler; the joined-string deps make
  // the effect re-subscribe only when the actual channels change.
  const queryKeyRef = useRef(queryKey);
  useEffect(() => { queryKeyRef.current = queryKey; });
  const wsEventsKey = wsEvents?.join('|') ?? '';
  const customEventsKey = customEvents?.join('|') ?? '';

  // Invalidate on WS events
  useEffect(() => {
    if (!wsEventsKey && !customEventsKey) return;
    mountedRef.current = true;

    const handler = (e: Event) => {
      if (!mountedRef.current) return;
      const detail = (e as CustomEvent).detail;
      const currentKey = queryKeyRef.current;
      // If the event has a queryKey filter, only invalidate matching queries
      if (detail?.queryKey && !currentKey.every((k, i) => detail.queryKey[i] === k)) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: currentKey });
    };

    const eventNames = [
      ...(wsEventsKey ? [...new Set(wsEventsKey.split('|').map((ch) => (
        ch === 'lane-lifecycle' || ch === 'agent-lifecycle' ? 'o8:lifecycle-reconcile' : `o8:${ch}`
      )))] : []),
      ...(customEventsKey ? customEventsKey.split('|') : []),
      'o8:invalidate', // global invalidation bus
    ];

    for (const name of eventNames) {
      window.addEventListener(name, handler);
    }

    return () => {
      mountedRef.current = false;
      for (const name of eventNames) {
        window.removeEventListener(name, handler);
      }
    };
  }, [wsEventsKey, customEventsKey, queryClient]);

  return result;
}

/**
 * Fire an invalidation event from anywhere (e.g. after a mutation).
 *
 * Usage:
 *   fireInvalidation('lane-lifecycle');
 *   fireInvalidation('invalidate', ['lanes', 'active']);
 */
export function fireInvalidation(channel: string, queryKey?: string[]) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(`o8:${channel}`, {
    detail: queryKey ? { queryKey } : undefined,
  }));
}
