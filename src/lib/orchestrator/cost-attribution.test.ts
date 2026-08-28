import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-cost-attribution-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { appendEvent, attachSession, createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { derivePacketAttemptIndex } = await import('./cost-attribution');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('derivePacketAttemptIndex', () => {
  function recordSuccessfulLaunch(laneId: string, sessionKey: string) {
    attachSession(laneId, sessionKey, 'system');
    setLaneStatus(laneId, 'running', 'system', 'session_launched');
  }

  it('counts a rerun replacement launch once without counting the retry signal again', () => {
    const packetId = 'packet-attempt-events';
    const first = createLane({
      repoPath: dataDir,
      branch: 'fix/attempt-first',
      runtime: 'codex',
      packetId,
    });
    recordSuccessfulLaunch(first.id, 'codex-owned:attempt-first');
    expect(derivePacketAttemptIndex({ packetId, laneId: first.id })).toBe(1);
    appendEvent(first.id, 'typecheck_auto_retry', 'system', { packetId });

    const rerun = createLane({
      repoPath: dataDir,
      branch: 'fix/attempt-rerun',
      runtime: 'codex',
      packetId,
    });
    recordSuccessfulLaunch(rerun.id, 'codex-owned:attempt-rerun');
    expect(derivePacketAttemptIndex({ packetId, laneId: rerun.id })).toBe(2);
  });

  it('counts a warm-session steer as a separate attempt without a launch', () => {
    const packetId = 'packet-steer-events';
    const lane = createLane({
      repoPath: dataDir,
      branch: 'fix/attempt-steer',
      runtime: 'codex',
      packetId,
    });
    recordSuccessfulLaunch(lane.id, 'codex-owned:attempt-steer');
    appendEvent(lane.id, 'steered_packet', 'orchestrator', { packetId, source: 'operator' });

    expect(derivePacketAttemptIndex({ packetId, laneId: lane.id })).toBe(2);
  });

  it('deduplicates two launch receipts emitted in the same lane window', () => {
    const packetId = 'packet-fallback-events';
    const lane = createLane({
      repoPath: dataDir,
      branch: 'fix/attempt-fallback',
      runtime: 'codex',
      packetId,
    });
    attachSession(lane.id, 'codex-owned:attempt-fallback', 'system');
    setLaneStatus(lane.id, 'running', 'system', 'worker_quota_fallback_launched');
    appendEvent(lane.id, 'worker_fallback', 'system', {
      packetId,
      status: 'redispatched',
    });

    expect(derivePacketAttemptIndex({ packetId, laneId: lane.id })).toBe(1);
  });
});
