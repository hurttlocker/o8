import type { MobilePendingTurnWorkers, MobileTurnReceipt } from '@/lib/mobile/types';

export function mergeMobileTurnReceipts(
  existing: MobileTurnReceipt | undefined,
  incoming: MobileTurnReceipt | undefined,
): MobileTurnReceipt | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const workers = new Map<string, NonNullable<MobileTurnReceipt['workers']>[number]>();
  for (const worker of existing.workers ?? []) workers.set(worker.packetId, worker);
  for (const worker of incoming.workers ?? []) workers.set(worker.packetId, worker);

  return {
    ...existing,
    ...incoming,
    ...(workers.size > 0 ? { workers: Array.from(workers.values()) } : {}),
  };
}

export function consumePendingTurnWorkers(
  pending: MobilePendingTurnWorkers | undefined,
  messageId: string,
  receipt: MobileTurnReceipt | undefined,
): { pending: MobilePendingTurnWorkers | undefined; receipt: MobileTurnReceipt | undefined } {
  const workers = pending?.[messageId];
  if (!workers?.length || !receipt) return { pending, receipt };
  const nextPending = { ...pending };
  delete nextPending[messageId];
  return {
    pending: Object.keys(nextPending).length > 0 ? nextPending : undefined,
    receipt: mergeMobileTurnReceipts(receipt, { ...receipt, workers }),
  };
}
