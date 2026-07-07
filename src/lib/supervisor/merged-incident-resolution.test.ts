import { describe, expect, it } from 'vitest';

import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { enqueueInboxItem, listInboxItems } from '@/lib/supervisor/inbox';
import {
  resolveVerificationIncidentsForMergedPacket,
  sweepMergedPacketVerificationIncidents,
} from '@/lib/supervisor/merged-incident-resolution';

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-incident-resolution',
    referenceLabel: 'P1',
    title: 'Incident queue hygiene',
    summary: 'Resolve stale verification incidents for terminal packets.',
    workspaceTargetPath: '/tmp/o8-incident-resolution',
    branchTarget: 'inline/incident-resolution',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: null,
    ...overrides,
  };
}

function seedPackets(packets: OrchestratorPacket[]) {
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-incident-resolution',
    repoPath: '/tmp/o8-incident-resolution',
    packets,
    updatedAt: '2026-07-07T12:00:00.000Z',
  });
}

function inboxByPacketId(packetId: string) {
  return listInboxItems({ includeAllProjects: true, includeDismissed: true })
    .filter((item) => item.packetId === packetId);
}

describe('merged packet verification incident resolution', () => {
  it('startup sweep resolves terminal verification incidents and leaves unmerged packets active', () => {
    const mergedPacket = packetFixture({
      id: 'pkt-merged-incident',
      status: 'released',
      releaseState: 'released',
      releaseStatePayload: {
        mergeCommit: 'abc123',
        releasedAt: '2026-07-07T12:00:00.000Z',
        source: 'approve_and_merge',
      },
      lane: {
        tileId: 'lane-merged-incident',
        tabId: 'lane-merged-incident',
        repoPath: '/tmp/o8-incident-resolution',
        runtime: 'codex',
        laneId: 'lane-merged-incident',
      },
    });
    const runningPacket = packetFixture({
      id: 'pkt-running-incident',
      status: 'running',
      releaseState: 'pending',
      lane: {
        tileId: 'lane-running-incident',
        tabId: 'lane-running-incident',
        repoPath: '/tmp/o8-incident-resolution',
        runtime: 'codex',
        laneId: 'lane-running-incident',
      },
    });
    seedPackets([mergedPacket, runningPacket]);

    enqueueInboxItem({
      repoPath: '/tmp/o8-incident-resolution',
      packetId: mergedPacket.id,
      kind: 'verification_failed',
      payload: {
        laneId: 'lane-merged-incident',
        verificationKind: 'typecheck',
        error: 'Verification Failed',
      },
    });
    enqueueInboxItem({
      repoPath: '/tmp/o8-incident-resolution',
      packetId: runningPacket.id,
      kind: 'verification_failed',
      payload: {
        laneId: 'lane-running-incident',
        verificationKind: 'typecheck',
        error: 'Verification Failed',
      },
    });

    expect(sweepMergedPacketVerificationIncidents({
      event: 'startup_sweep',
      now: new Date('2026-07-07T12:01:00.000Z'),
    })).toBe(1);

    const [mergedIncident] = inboxByPacketId(mergedPacket.id);
    expect(mergedIncident?.status).toBe('resolved');
    expect(mergedIncident?.resolutionLaneId).toBe('lane-merged-incident');
    expect(mergedIncident?.payload.autoResolution).toMatchObject({
      packetId: mergedPacket.id,
      laneId: 'lane-merged-incident',
      event: 'startup_sweep',
      terminalState: 'released',
    });
    expect(mergedIncident?.payload.autoResolutionNote).toContain('Auto-resolved: lane merged');

    const [runningIncident] = inboxByPacketId(runningPacket.id);
    expect(runningIncident?.status).toBe('human_required');
    expect(runningIncident?.payload.autoResolution).toBeUndefined();
  });

  it('on-merge resolver resolves archived silent-exit incidents without touching non-verification kinds', () => {
    const archivedPacket = packetFixture({
      id: 'pkt-archived-incident',
      status: 'archived',
      archivedAt: '2026-07-07T12:05:00.000Z',
      lane: {
        tileId: 'lane-archived-incident',
        tabId: 'lane-archived-incident',
        repoPath: '/tmp/o8-incident-resolution',
        runtime: 'codex',
        laneId: 'lane-archived-incident',
      },
    });
    seedPackets([archivedPacket]);

    enqueueInboxItem({
      repoPath: '/tmp/o8-incident-resolution',
      packetId: archivedPacket.id,
      kind: 'silent_exit_no_work',
      payload: {
        laneId: 'lane-archived-incident',
        error: 'Agent exited silently.',
      },
    });
    enqueueInboxItem({
      repoPath: '/tmp/o8-incident-resolution',
      packetId: archivedPacket.id,
      kind: 'merge_blocked',
      payload: {
        laneId: 'lane-archived-incident',
        error: 'Merge is blocked.',
      },
    });

    expect(resolveVerificationIncidentsForMergedPacket({
      packetId: archivedPacket.id,
      laneId: 'lane-archived-incident',
      event: 'approve_and_merge',
      now: new Date('2026-07-07T12:06:00.000Z'),
    })).toBe(1);

    const incidents = inboxByPacketId(archivedPacket.id);
    expect(incidents.find((item) => item.kind === 'silent_exit_no_work')?.status).toBe('resolved');
    expect(incidents.find((item) => item.kind === 'silent_exit_no_work')?.payload.autoResolution).toMatchObject({
      packetId: archivedPacket.id,
      laneId: 'lane-archived-incident',
      event: 'approve_and_merge',
      terminalState: 'archived',
    });
    expect(incidents.find((item) => item.kind === 'merge_blocked')?.status).toBe('human_required');
  });
});
