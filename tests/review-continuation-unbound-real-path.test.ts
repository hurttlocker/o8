import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

/**
 * #3727: a mission with no recorded chat origin (a turn sent without a thread,
 * or a mission created over MCP or the CLI) reached review and the repository's
 * default orchestrator session was woken with a review-and-merge template, then
 * merged despite the operator's "do not merge". Driven through persisted mission
 * state, a real lane, the real origin resolver and the real operator default.
 */
const dir = mkdtempSync(join(os.tmpdir(), 'o8-review-unbound-'));
process.env.CORTEX_IDE_DATA_DIR = dir;
process.env.O8_DATA_DIR = dir;

vi.mock('@/lib/orchestrator/wake-triage', () => ({ startWakeTriage: vi.fn() }));

const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { resolveReviewContinuationSync } = await import('@/lib/operator/defaults');
const { POST } = await import('@/app/api/panel/operator-defaults/route');
const { queueReviewContinuation, routeReviewContinuation } = await import('@/lib/orchestrator/review-continuation');
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

function unboundMission(repoPath: string, packetId: string) {
  const lane = createLane({ repoPath, branch: `inline/${packetId}`, runtime: 'pi', packetId });
  setLaneStatus(lane.id, 'reviewing', 'system', 'test_review_ready');
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${packetId}`,
    repoPath,
    packets: [{
      id: packetId, referenceLabel: packetId.toUpperCase(), title: packetId, summary: packetId,
      status: 'review', queueState: 'queued', releaseState: 'pending', runtime: 'pi', wave: 1,
      dependencyPacketIds: [], dependencyLabels: [], blockedReason: null, lane: null, review: null,
      workspaceTargetPath: repoPath, branchTarget: `inline/${packetId}`,
      // No orchestratorThreadId / orchestratorTurnId: the mission has no chat origin.
    } as unknown as OrchestratorPacket],
  });
  return { id: lane.id, label: lane.label, repoPath, packetId, branch: lane.branch };
}

const unboundEvents = (laneId: string) => getLaneEvents(laneId, 50)
  .filter(event => (event.payload as { event?: string }).event === 'review_continuation_unbound');

describe('#3727 review continuation without a chat origin', () => {
  it('leaves the lane at review and wakes no session, with continuation on by default', () => {
    expect(resolveReviewContinuationSync()).toBe(true);
    const lane = unboundMission(mkdtempSync(join(os.tmpdir(), 'o8-repo-')), 'packet-unbound');
    const persistentLead = vi.fn(() => false);
    const toOriginThread = vi.fn();

    routeReviewContinuation(lane, persistentLead, toOriginThread);

    expect(persistentLead).toHaveBeenCalledOnce();
    expect(toOriginThread).not.toHaveBeenCalled();
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(unboundEvents(lane.id)).toHaveLength(1);
  });

  it('stays silent when the operator turned review continuation off', async () => {
    const res = await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewContinuation: false }),
    }));
    expect(res.status).toBe(200);
    const lane = unboundMission(mkdtempSync(join(os.tmpdir(), 'o8-repo-')), 'packet-off');
    routeReviewContinuation(lane, () => false, vi.fn());
    expect(unboundEvents(lane.id)).toHaveLength(0);
    await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewContinuation: true }),
    }));
  });

  it('the review turn for an owning thread defers to that thread before any merge', () => {
    const enqueue = vi.fn();
    queueReviewContinuation({ id: 'lane-bound', label: 'Bound', repoPath: '/repo', packetId: 'packet-bound' }, enqueue, 'durable');
    const message = enqueue.mock.calls[0]?.[1] as string;
    expect(message).toContain('if the operator said not to merge');
    expect(message).toContain('do not call approve_and_merge');
  });

  it('the server no longer hands review continuation to the default-session queue', () => {
    const source = readFileSync(join(process.cwd(), 'src/ws-server.ts'), 'utf8');
    const call = source.slice(source.indexOf('routeReviewContinuation(lane,'), source.indexOf('routeReviewContinuation(lane,') + 200);
    expect(call).not.toContain('enqueueOrchestratorAutoMessage');
  });
});
