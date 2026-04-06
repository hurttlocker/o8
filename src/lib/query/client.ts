/**
 * Shared TanStack Query client — single instance for the app.
 *
 * Default config:
 *   - staleTime: 30s (data considered fresh for 30s after fetch)
 *   - gcTime: 5min (unused cache entries garbage collected after 5min)
 *   - retry: 1 (one retry on failure, fast fail)
 *   - refetchOnWindowFocus: false (we use WS events, not focus refetch)
 */

import { QueryClient } from '@tanstack/react-query';

let queryClient: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (!queryClient) {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          gcTime: 5 * 60_000,
          retry: 1,
          refetchOnWindowFocus: false,
          refetchOnReconnect: true,
        },
      },
    });
  }
  return queryClient;
}
