import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { REPO_INVENTORY_RUNTIME } from './inventory-change';

/**
 * Wraps a route handler so every successful repository or project change
 * tells open windows to reload their repositories and projects (#3559).
 */
export function withRepoInventoryChange<A extends unknown[]>(action: string, handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    const response = await handler(...args);
    if (response.ok) {
      const now = new Date().toISOString();
      await publishRealtimeMutation({
        mutation: {
          mutationId: `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          source: 'server', action, runtime: REPO_INVENTORY_RUNTIME, status: 'completed',
          createdAt: now, settledAt: now,
        },
        refreshTargets: ['global'],
      });
    }
    return response;
  };
}
