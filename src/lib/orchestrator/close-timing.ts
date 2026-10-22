import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { recordLaneEvent } from '@/lib/lane/events';
import { closeArtifactReaderDiagnostics, withCloseArtifactReader } from '@/lib/workspace/ignored-artifact-io';
import { closeProcessScanCounts, withCloseProcessObservation } from '@/lib/runtime/close-process-observation';

const timing = new AsyncLocalStorage<Record<string, number>>();

export async function timeClosePhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const phases = timing.getStore();
  const start = performance.now();
  try { return await operation(); }
  finally {
    if (phases) phases[phase] = (phases[phase] ?? 0) + performance.now() - start;
  }
}

export async function withCloseTiming<T>(packetId: string, operation: () => Promise<T>): Promise<T> {
  const phases: Record<string, number> = {};
  const start = performance.now();
  let scans = { openFiles: 0, cwdProjections: 0 };
  let artifactHelperStarts = 0;
  const close = async () => {
    try { return await operation(); }
    finally {
      scans = closeProcessScanCounts() ?? scans;
      artifactHelperStarts = closeArtifactReaderDiagnostics()?.starts ?? 0;
    }
  };
  try {
    return await withCloseProcessObservation(() => timing.run(phases, () => withCloseArtifactReader(close)));
  } finally {
    try {
      const lane = findLatestLaneByPacket(packetId);
      if (lane) recordLaneEvent(lane.id, 'close_timing', 'system', {
        packetId, totalMs: performance.now() - start, phases, scans, artifactHelperStarts,
      });
    } catch { console.warn('[close-timing] Could not persist close phase receipt.'); }
  }
}
