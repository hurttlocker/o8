import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

// #2048 — the headless loop is a long-lived process that re-runs the recovery
// gate every tick (10s). A packet blocked on a condition only the operator can
// clear ("runtime is not pinned") is re-evaluated forever, and logging every
// evaluation flooded serve.log with 38,008 identical lines in 27 hours. Remember
// the last blocker we PRINTED per packet, fingerprinted by reason + pinned
// runtime: the same reason under the same runtime stays silent, and a changed
// runtime (or a different blocker) prints once more.
const loggedRecoverySkips = new Map<string, string>();

function recoverySkipFingerprint(reason: string, pinnedRuntime: OrchestratorRuntime | null): string {
  return `${reason}::${pinnedRuntime ?? 'unpinned'}`;
}

/** True the first time this packet is skipped for this reason+runtime pair. */
export function shouldLogRecoverySkip(
  packetId: string,
  reason: string,
  pinnedRuntime: OrchestratorRuntime | null,
): boolean {
  const fingerprint = recoverySkipFingerprint(reason, pinnedRuntime);
  if (loggedRecoverySkips.get(packetId) === fingerprint) return false;
  loggedRecoverySkips.set(packetId, fingerprint);
  return true;
}

/** Forget a packet's memoized skip so its next block logs again. */
export function forgetRecoverySkip(packetId: string): void {
  loggedRecoverySkips.delete(packetId);
}

/** Test seam — drop every memoized skip. */
export function resetRecoverySkipMemo(): void {
  loggedRecoverySkips.clear();
}

/** Keep the memo bounded by the live packet set — a daemon runs for weeks. */
export function pruneRecoverySkipMemo(livePacketIds: Set<string>): void {
  for (const packetId of loggedRecoverySkips.keys()) {
    if (!livePacketIds.has(packetId)) loggedRecoverySkips.delete(packetId);
  }
}
