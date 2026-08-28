/**
 * Real-path coverage for the fleet narration bridge (#1616 — voice slice).
 *
 * The reachability trap this guards: the narration CORE (normalize + policy) was
 * fully unit-tested yet UNREACHABLE — nothing fed it live fleet transitions. A
 * green policy suite proves the mechanism, not that a real lane event reaches
 * it. So this suite drives the ACTUAL route handler against the ACTUAL live
 * lane-lifecycle ring buffer: record a real blocking transition via
 * `recordLaneEvent` (the same emit seam lane lifecycle uses), then invoke
 * `GET /api/voice/narration` and assert a spoken NarrationDecision comes back.
 *
 * The data dir + ws-token are written to a temp dir BEFORE any import because
 * the auth + DB modules resolve their dir at module load.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';

const WS_TOKEN = 'vitest-voice-narration-token-0123456789';
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-voice-narration-'));
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_VOICE_NARRATION = '1';

const { recordLaneEvent } = await import('@/lib/orchestrator/runtime-status');
const { GET } = await import('@/app/api/voice/narration/route');
const {
  decideNarrationForRecords,
  freshVoiceBudget,
  voiceNarrationEnabled,
} = await import('@/lib/voice/fleet-narration-bridge');
import type { LaneLifecycleEventRecord } from '@/lib/orchestrator/runtime-status';

/** Loopback GET so the in-handler requirePanelAuth passes (host is loopback). */
function narrationRequest(since: number): NextRequest {
  return new NextRequest(`http://localhost:3001/api/voice/narration?since=${since}`, {
    method: 'GET',
    headers: { host: 'localhost:3001' },
  });
}

describe('voice narration — live bus → policy → route (real path)', () => {
  it('the capability flag is honored (O8_VOICE_NARRATION=1)', () => {
    expect(voiceNarrationEnabled()).toBe(true);
  });

  it('a real blocking lane transition produces a spoken NarrationDecision through the route', async () => {
    // Cursor at the current tip so we only see the event we record next.
    const { nextSince: cursor } = await (
      await import('@/lib/orchestrator/runtime-status')
    ).getLaneEventsSince(0, 0);

    // Emit a REAL lane-lifecycle transition on the live ring buffer.
    recordLaneEvent({
      laneId: 'lane-voice-1',
      packetId: 'packet-voice-1',
      status: 'awaiting_human',
      previousStatus: 'running',
      sessionKey: 'codex-owned:voice-demo',
      branch: 'issue/1616-voice',
      repoPath: '/tmp/repo',
      timestamp: new Date().toISOString(),
    });

    const res = await GET(narrationRequest(cursor));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);
    expect(Array.isArray(body.spoken)).toBe(true);
    expect(body.spoken.length).toBeGreaterThan(0);

    const spoken = body.spoken[0];
    expect(spoken.tier).toBe('interrupt-now');
    expect(spoken.action).toBe('speak');
    expect(spoken.holdUntilPause).toBe(false);
    expect(typeof spoken.utterance).toBe('string');
    expect(spoken.utterance.length).toBeGreaterThan(0);
    // nextSince advances past the recorded event so the next poll is incremental.
    expect(body.nextSince).toBeGreaterThan(cursor);
  });

  it('an unauthenticated LAN request is rejected before any narration', async () => {
    const lanReq = new NextRequest('http://192.168.1.50:3001/api/voice/narration?since=0', {
      method: 'GET',
      headers: { host: '192.168.1.50:3001' },
    });
    const res = await GET(lanReq);
    expect(res.status).toBe(401);
  });
});

describe('voice narration — pure core', () => {
  function record(
    partial: Partial<LaneLifecycleEventRecord> & Pick<LaneLifecycleEventRecord, 'status' | 'previousStatus' | 'seq'>,
  ): LaneLifecycleEventRecord {
    return {
      laneId: 'lane-1',
      packetId: 'packet-1',
      sessionKey: 'codex-owned:demo',
      branch: 'main',
      repoPath: '/tmp/repo',
      timestamp: new Date().toISOString(),
      ...partial,
    };
  }

  it('drops non-transitions (previousStatus === status)', () => {
    const result = decideNarrationForRecords({
      records: [record({ status: 'running', previousStatus: 'running', seq: 1 })],
      budget: freshVoiceBudget(),
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.spoken).toHaveLength(0);
  });

  it('holds a non-blocking FYI (launch) instead of speaking it', () => {
    const result = decideNarrationForRecords({
      records: [record({ status: 'launching', previousStatus: 'idle', seq: 2 })],
      budget: freshVoiceBudget(),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].tier).toBe('ambient-rollup');
    expect(result.decisions[0].action).toBe('hold');
    expect(result.spoken).toHaveLength(0);
  });

  it('speaks a blocking transition (failure) with interrupt-now', () => {
    const result = decideNarrationForRecords({
      records: [record({ status: 'failed', previousStatus: 'running', seq: 3 })],
      budget: freshVoiceBudget(),
    });
    expect(result.spoken).toHaveLength(1);
    expect(result.spoken[0].tier).toBe('interrupt-now');
    expect(result.spoken[0].action).toBe('speak');
  });
});
