import {
  fetchCorrelatedActionReceipt,
  type CorrelatedActionPayload,
} from '@/lib/orchestrator/action-receipt';

export type RuntimeArchiveTarget =
  | { sessionKey: string; laneId?: never }
  | { laneId: string; sessionKey?: never };

export interface RuntimeArchiveReceipt extends CorrelatedActionPayload {
  ok?: boolean;
  archived?: boolean;
  clientMutationId?: string;
  sessionKey?: string;
  laneId?: string;
  note?: string;
  error?: string;
  replayed?: boolean;
  persistenceDegraded?: boolean;
}

export async function archiveRuntimeTarget(
  target: RuntimeArchiveTarget,
  clientMutationId: string,
  receiptOptions?: { timeoutMs?: number; pollMs?: number },
): Promise<RuntimeArchiveReceipt> {
  const requestBody = JSON.stringify({ ...target, clientMutationId });
  const { response, payload } = await fetchCorrelatedActionReceipt<RuntimeArchiveReceipt>(
    '/api/runtime/archive',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    },
    receiptOptions,
  );

  if (!response.ok || payload?.ok !== true || payload.archived !== true) {
    throw new Error(
      payload?.error
      ?? payload?.note
      ?? `Archive failed with status ${response.status}`,
    );
  }
  return payload;
}
