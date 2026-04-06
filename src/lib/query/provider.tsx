'use client';

/**
 * ReactiveQueryProvider — wraps TanStack QueryClientProvider.
 *
 * Drop this around the dashboard layout. All useReactiveQuery hooks
 * inside will share the same cache and WS-driven invalidation.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { getQueryClient } from './client';
import type { ReactNode } from 'react';

export function ReactiveQueryProvider({ children }: { children: ReactNode }) {
  const client = getQueryClient();
  return (
    <QueryClientProvider client={client}>
      {children}
    </QueryClientProvider>
  );
}
