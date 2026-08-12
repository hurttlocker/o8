import { describe, expect, it } from 'vitest';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  projectPacketLaneBindings,
  projectWorkerParticipants,
  resolveWorkerParticipantRef,
} from './participant-projection';

function packet(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'packet-one',
    referenceLabel: 'P1',
    title: 'Implement mesh identity',
    summary: 'Keep one participant across reconnects',
    workspaceTargetPath: '/repo/one',
    branchTarget: 'agent/mesh',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    ...overrides,
  };
}

function lane(overrides: Partial<Lane> = {}): Lane {
  return {
    id: 'lane-one',
    projectId: null,
    label: 'Mesh worker',
    repoPath: '/repo/one',
    worktreePath: '/repo/one-worktree',
    branch: 'agent/mesh',
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: 'codex-owned:new',
    packetId: 'packet-one',
    prNumber: null,
    status: 'running',
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: '2026-08-11T10:00:00.000Z',
    updatedAt: '2026-08-11T10:02:00.000Z',
    lastEventAt: '2026-08-11T10:02:00.000Z',
    lastEventLabel: 'session_attached',
    ...overrides,
  };
}

describe('worker participant projection', () => {
  it('uses packet identity while the lane session rotates', () => {
    const first = projectWorkerParticipants({
      packets: [packet()],
      lanes: [lane({ sessionKey: 'codex-owned:old' })],
    });
    const second = projectWorkerParticipants({
      packets: [packet()],
      lanes: [lane({ sessionKey: 'codex-owned:new' })],
      runtimeTruth: [
        { sessionKey: 'codex-owned:old', runtime: 'codex', packetId: 'packet-one', status: 'stopped' },
        { sessionKey: 'codex-owned:new', runtime: 'codex', packetId: 'packet-one', status: 'running' },
      ],
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: 'packet-one', identityKind: 'packet' });
    expect(second[0]).toMatchObject({
      id: 'packet-one',
      sessionKey: 'codex-owned:new',
      controlRef: { kind: 'packet', id: 'packet-one' },
      lifecycle: { connected: true, runtimeStatus: 'running' },
    });
  });

  it('collapses archived and replacement lanes for one packet onto the live lane', () => {
    const participants = projectWorkerParticipants({
      packets: [packet({ lane: null })],
      lanes: [
        lane({ id: 'lane-old', sessionKey: 'codex-owned:old', status: 'archived', updatedAt: '2026-08-11T10:03:00.000Z' }),
        lane({ id: 'lane-new', sessionKey: 'codex-owned:new', status: 'running', updatedAt: '2026-08-11T10:02:00.000Z' }),
      ],
    });

    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({
      id: 'packet-one',
      laneId: 'lane-new',
      sessionKey: 'codex-owned:new',
    });
  });

  it('exposes existing truth and falls back from lane to session identity', () => {
    const laneParticipant = projectWorkerParticipants({
      packets: [],
      lanes: [lane({ packetId: null })],
      runtimeTruth: [{
        sessionKey: 'codex-owned:new',
        runtime: 'codex',
        laneId: 'lane-one',
        model: 'gpt-test',
        status: 'running',
        connected: true,
      }],
    })[0];
    const sessionParticipant = projectWorkerParticipants({
      packets: [],
      lanes: [],
      runtimeTruth: [{
        sessionKey: 'opencode-owned:outside',
        runtime: 'opencode',
        repoPath: '/repo/two',
        currentTask: 'Inspect another repo',
        status: 'running',
      }],
    })[0];

    expect(laneParticipant).toMatchObject({
      id: 'lane-one',
      identityKind: 'lane',
      model: 'gpt-test',
      lifecycle: { connected: true, laneStatus: 'running', runtimeStatus: 'running' },
      controlRef: { kind: 'lane', id: 'lane-one' },
    });
    expect(sessionParticipant).toMatchObject({
      id: 'opencode-owned:outside',
      identityKind: 'session',
      repoPath: '/repo/two',
      runtime: 'opencode',
      taskSummary: 'Inspect another repo',
      controlRef: { kind: 'session', id: 'opencode-owned:outside' },
    });
  });

  it('projects launch origin, placement, routing, and task truth from the packet', () => {
    const participant = projectWorkerParticipants({
      packets: [packet({
        launchContext: {
          source: 'mcp',
          presentation: 'split',
          repoContext: 'transient',
          caller: 'outside terminal',
          parentWorkspaceId: 'workspace-one',
          parentThreadId: 'thoughts-one',
        },
        workerRouting: { selectedModel: 'gpt-test' } as OrchestratorPacket['workerRouting'],
      })],
      lanes: [lane()],
    })[0];

    expect(participant).toMatchObject({
      repoPath: '/repo/one',
      runtime: 'codex',
      model: 'gpt-test',
      origin: 'outside terminal via o8 MCP',
      taskSummary: 'Keep one participant across reconnects',
      launchContext: {
        parentWorkspaceId: 'workspace-one',
        parentThreadId: 'thoughts-one',
      },
    });
  });

  it('adapts persisted packet lane bindings for browser consumers', () => {
    const inputPacket = packet({
      lane: {
        tileId: 'mcp-dispatch',
        tabId: 'mcp-dispatch',
        repoPath: '/repo/one',
        runtime: 'codex',
        laneId: 'lane-bound',
        sessionKey: 'codex-owned:rotated',
        lastEventAt: '2026-08-11T10:04:00.000Z',
        lastEventLabel: 'session_attached',
      },
    });

    expect(projectPacketLaneBindings([inputPacket])).toEqual([expect.objectContaining({
      id: 'lane-bound',
      packetId: 'packet-one',
      sessionKey: 'codex-owned:rotated',
    })]);
    expect(projectWorkerParticipants({ packets: [inputPacket] })).toEqual([
      expect.objectContaining({
        id: 'packet-one',
        laneId: 'lane-bound',
        sessionKey: 'codex-owned:rotated',
      }),
    ]);
  });

  it('resolves packet then lane then session participant refs', () => {
    expect(resolveWorkerParticipantRef({
      packetId: 'packet-one',
      laneId: 'lane-one',
      sessionKey: 'session-one',
    })).toMatchObject({
      participantId: 'packet-one',
      identityKind: 'packet',
      controlRef: { kind: 'packet', id: 'packet-one' },
    });
    expect(resolveWorkerParticipantRef({ laneId: 'lane-one', sessionKey: 'session-one' })).toMatchObject({
      participantId: 'lane-one',
      identityKind: 'lane',
    });
    expect(resolveWorkerParticipantRef({ sessionKey: 'session-one' })).toMatchObject({
      participantId: 'session-one',
      identityKind: 'session',
    });
  });
});
