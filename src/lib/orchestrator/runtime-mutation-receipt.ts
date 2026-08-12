import {
  fetchCorrelatedActionReceipt,
  type CorrelatedActionReceipt,
} from '@/lib/orchestrator/action-receipt';

export interface RuntimeMutationReceiptPayload {
  ok?: boolean;
  error?: string;
  note?: string;
  surfaceId?: string;
  inProgress?: boolean;
  status?: string;
}

export type RuntimeMutationReceipt = CorrelatedActionReceipt<RuntimeMutationReceiptPayload>;

export function fetchRuntimeLaunchReceipt(
  launchIntent: Record<string, unknown>,
): Promise<RuntimeMutationReceipt> {
  const requestBody = JSON.stringify({
    ...launchIntent,
    clientMutationId: crypto.randomUUID(),
  });
  return fetchCorrelatedActionReceipt<RuntimeMutationReceiptPayload>('/api/runtime/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
  });
}

export function fetchRuntimeSteerReceipt(
  surfaceId: string,
  message: string,
): Promise<RuntimeMutationReceipt> {
  const requestBody = JSON.stringify({
    action: 'steer',
    surfaceId,
    clientMutationId: crypto.randomUUID(),
    message,
  });
  return fetchCorrelatedActionReceipt<RuntimeMutationReceiptPayload>('/api/runtime/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
  });
}
