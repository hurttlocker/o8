import { describe, expect, it } from 'vitest';
import {
  deriveSpawnedAgentRows,
  type LaneSummary,
} from './AgentPanelExtraAgents';
import { canArchiveExtraAgent, type ExtraAgentRow } from './AgentPanelExtraAgentRow';

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
