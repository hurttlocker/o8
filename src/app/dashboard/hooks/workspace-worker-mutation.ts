import type { RealtimeEventEnvelope, RealtimeMutationRecord } from '@/lib/realtime/types';
import type { DispatchedWorkerLane } from './dispatched-worker-lane';
import { dispatchedWorkerRuntime } from './dispatched-worker-lane';

/** Convert live packet and Fast launch mutations into native workspace workers. */
export function openWorkerFromMutation(
  event: RealtimeEventEnvelope,
  openWorker: (lane: DispatchedWorkerLane) => Promise<void>,
): boolean {
  if (event.channel !== 'mutation') return false;
  if (event.event !== 'mutation.record' && event.event !== 'mutation.settled') return false;
  const mutation = (event.data as { mutation?: RealtimeMutationRecord }).mutation;
  if (!mutation || !mutation.sessionKey || !mutation.repoPath || mutation.status === 'failed') return false;
  if (mutation.action === 'launch' && mutation.launchContext?.checkoutMode === 'shared') {
    void openWorker({
      sessionKey: mutation.sessionKey,
      runtime: dispatchedWorkerRuntime(mutation.runtime),
      repoPath: mutation.repoPath,
      status: 'launching',
      packetTitle: mutation.note ?? 'Fast worker',
      launchContext: mutation.launchContext,
    });
    return true;
  }
  if (mutation.action !== 'packet-dispatch') return false;
  void openWorker({
    laneId: mutation.laneId ?? null,
    packetId: mutation.packetId ?? null,
    packetReferenceLabel: mutation.packetReferenceLabel ?? null,
    packetTitle: mutation.packetTitle ?? null,
    sessionKey: mutation.sessionKey,
    runtime: dispatchedWorkerRuntime(mutation.runtime),
    repoPath: mutation.repoPath,
    status: 'launching',
    branch: mutation.branch ?? null,
    launchContext: mutation.launchContext ?? null,
  });
  return true;
}
