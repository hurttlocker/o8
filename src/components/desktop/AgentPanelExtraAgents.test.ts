import { describe, expect, it } from 'vitest';
import type { AgentSummary } from '@/lib/fleet/types';
import {
  deriveSpawnedAgentRows,
  isRailLane,
  type LaneSummary,
} from './AgentPanelExtraAgents';
import {
  canArchiveExtraAgent,
  isClearableExtraAgent,
  type ExtraAgentRow,
} from './AgentPanelExtraAgentRow';

describe('Agents rail derivation', () => {
  it('keeps worker packets in one flat list across repositories', () => {
    const lane: LaneSummary = {
      id: 'lane-running',
      label: 'Cross-repo worker',
      repoPath: '/repos/worker-repo',
      branch: 'issue/cross-repo',
      runtime: 'codex',
      sessionKey: 'codex-owned:lane-running',
      packetId: 'pkt-running',
      status: 'running',
      ownership: 'managed',
      lastEventAt: '2026-07-19T00:01:00.000Z',
      lastEventLabel: 'agent_progress',
    };
    const sameRepoLane: LaneSummary = {
      ...lane,
      id: 'lane-same-repo',
      label: 'Same-repo worker',
      repoPath: '/repos/project-repo',
      sessionKey: 'codex-owned:lane-same-repo',
      packetId: 'pkt-same-repo',
      lastEventAt: '2026-07-19T00:02:00.000Z',
    };

    expect(deriveSpawnedAgentRows({
      lanes: [lane, sameRepoLane],
      agents: [],
    }).map((row) => row.packetId)).toEqual(['pkt-running', 'pkt-same-repo']);
  });

  it('removes only explicitly archived sessions', () => {
    const lane: LaneSummary = {
      id: 'lane-running',
      label: 'Worker',
      repoPath: '/repos/project-repo',
      branch: 'issue/worker',
      runtime: 'codex',
      sessionKey: 'codex-owned:lane-running',
      packetId: 'pkt-running',
      status: 'running',
      ownership: 'managed',
      lastEventAt: '2026-07-19T00:01:00.000Z',
      lastEventLabel: 'agent_progress',
    };

    expect(deriveSpawnedAgentRows({
      lanes: [lane],
      agents: [],
      archivedSessionKeys: new Set(['codex-owned:lane-running']),
    })).toEqual([]);
  });

  it('carries the fleet status evidence onto the matching lane row', () => {
    const sessionKey = 'codex-owned:lane-evidence';
    const statusEvidence = {
      sessionId: sessionKey,
      runtime: 'codex' as const,
      state: 'blocked' as const,
      authority: 'lane-state' as const,
      observedAt: '2026-08-29T12:00:00.000Z',
      summary: 'Lane is waiting for approval.',
      evidence: [{ source: 'lane:lane-evidence.status', value: 'awaiting_human' }],
    };
    const lane: LaneSummary = {
      id: 'lane-evidence',
      label: 'Evidence worker',
      repoPath: '/repos/project-repo',
      branch: 'issue/evidence',
      runtime: 'codex',
      sessionKey,
      packetId: 'pkt-evidence',
      status: 'awaiting_human',
      ownership: 'managed',
      lastEventAt: statusEvidence.observedAt,
      lastEventLabel: 'approval_requested',
    };
    const agent = {
      id: 'agent-evidence',
      name: 'Evidence worker',
      squadId: 'default',
      sessionKey,
      runtime: 'codex',
      model: 'gpt-5',
      status: 'blocked',
      currentTask: 'Waiting for approval',
      workspace: lane.repoPath,
      branch: lane.branch,
      approvalStatus: 'pending',
      lastEventAt: statusEvidence.observedAt,
      context: { usedPercent: 0, trend: 'stable' },
      alerts: 0,
      statusEvidence,
    } satisfies AgentSummary;

    const [row] = deriveSpawnedAgentRows({ lanes: [lane], agents: [agent] });

    expect(row?.statusEvidence).toEqual(statusEvidence);
  });

  it('hides an explicitly archived sessionless lane row', () => {
    const lane: LaneSummary = {
      id: 'lane-sessionless',
      label: 'Failed worker',
      repoPath: '/repos/project-repo',
      branch: 'issue/failed-worker',
      runtime: 'opencode',
      sessionKey: null,
      packetId: 'pkt-failed',
      status: 'failed',
      ownership: 'managed',
      lastEventAt: '2026-07-19T00:01:00.000Z',
      lastEventLabel: 'zero_diff_failed',
    };

    expect(deriveSpawnedAgentRows({
      lanes: [lane],
      agents: [],
      archivedRowKeys: new Set([`lane:${lane.id}`]),
    })).toEqual([]);
  });

  it('drops an operator-archived lane and keeps the auto-archived outcome chip', () => {
    const now = Date.parse('2026-09-11T12:00:00.000Z');
    const archived: LaneSummary = {
      id: 'lane-archived',
      label: 'Discarded worker',
      repoPath: '/repos/project-repo',
      branch: 'issue/discarded',
      runtime: 'codex',
      sessionKey: null,
      packetId: 'pkt-discarded',
      status: 'archived',
      outcome: 'discarded',
      ownership: 'managed',
      lastEventAt: '2026-09-11T11:00:00.000Z',
      lastEventLabel: 'archived',
    };

    // The operator dismissed it — it belongs in the Archived section now.
    expect(isRailLane({ ...archived, archivedByOperator: true }, now)).toBe(false);
    // The headless loop tidied a merged lane — its 24h chip stays on the rail.
    expect(isRailLane({ ...archived, outcome: 'merged' }, now)).toBe(true);
    // Live lanes are never filtered, however they were archived before.
    expect(isRailLane({ ...archived, status: 'running', outcome: null }, now)).toBe(true);
    // Stale and outcome-less archives stay hidden, as before.
    expect(isRailLane({ ...archived, lastEventAt: '2026-09-09T11:00:00.000Z' }, now)).toBe(false);
    expect(isRailLane({ ...archived, outcome: null }, now)).toBe(false);
  });

  it('clears only lanes whose lifecycle is over', () => {
    const row = { key: 'lane:1', laneId: 'lane-1', laneStatus: 'failed' } as ExtraAgentRow;

    expect(isClearableExtraAgent(row)).toBe(true);
    expect(isClearableExtraAgent({ ...row, laneStatus: 'completed' })).toBe(true);
    expect(isClearableExtraAgent({ ...row, laneStatus: 'running' })).toBe(false);
    expect(isClearableExtraAgent({ ...row, laneStatus: 'reviewing' })).toBe(false);
    expect(isClearableExtraAgent({ ...row, laneStatus: 'awaiting_human' })).toBe(false);
    expect(isClearableExtraAgent({ ...row, laneStatus: null })).toBe(false);
  });

  it('offers lane archiving only for sessionless terminal rows', () => {
    const row = {
      key: 'lane:lane-sessionless',
      sessionKey: null,
      laneId: 'lane-sessionless',
      laneStatus: 'failed',
    } as ExtraAgentRow;

    expect(canArchiveExtraAgent(row)).toBe(true);
    expect(canArchiveExtraAgent({ ...row, laneStatus: 'running' })).toBe(false);
    expect(canArchiveExtraAgent({ ...row, laneId: null })).toBe(false);
  });
});
