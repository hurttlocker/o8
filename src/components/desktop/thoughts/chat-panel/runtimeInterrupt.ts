import {
  correlatedActionIsUnsettled,
  fetchCorrelatedActionReceipt,
} from '@/lib/orchestrator/action-receipt';

interface PendingRuntimeInterrupt {
  requestBody: string;
  promise: Promise<void> | null;
}

const pendingRuntimeInterrupts = new Map<string, PendingRuntimeInterrupt>();

export async function interruptRuntimeSurface(surfaceId: string | null | undefined): Promise<void> {
  if (!surfaceId) return;
  const existing = pendingRuntimeInterrupts.get(surfaceId);
  if (existing?.promise) return existing.promise;
  const pending = existing ?? {
    requestBody: JSON.stringify({
      action: 'interrupt',
      surfaceId,
      clientMutationId: crypto.randomUUID(),
    }),
    promise: null,
  };
  const request = (async () => {
    let terminal = false;
    try {
      const { response, payload } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        note?: string;
        error?: string;
        inProgress?: boolean;
        status?: string;
      }>('/api/runtime/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: pending.requestBody,
      });
      terminal = true;
      if (!response.ok || payload?.ok === false) {
        console.warn('[thoughts-chat] Failed to interrupt runtime steer target.');
      }
    } catch (error) {
      if (correlatedActionIsUnsettled(error)) {
        console.warn('[thoughts-chat] Runtime interrupt receipt is still unsettled.');
      } else {
        terminal = true;
        console.warn('[thoughts-chat] Failed to interrupt runtime steer target.');
      }
    } finally {
      if (terminal) pendingRuntimeInterrupts.delete(surfaceId);
      else pending.promise = null;
    }
  })();
  pending.promise = request;
  pendingRuntimeInterrupts.set(surfaceId, pending);
  try {
    await request;
  } finally {
    if (pending.promise === request) pending.promise = null;
  }
}
