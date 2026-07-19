import { describe, expect, it } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { deriveNestedPacketIds } from './repo-focus/tabs/chats/helpers';
import type { ChatHistoryItem } from './repo-focus/tabs/chats/types';
import type { RepoFocusRepo } from './repo-focus/types';
import {
  deriveSpawnedAgentGroups,
  type LaneSummary,
  type RegisteredRepo,
} from './AgentPanelExtraAgents';

function repo(name: string): RepoFocusRepo {
  return {
    id: name,
    name,
    localPath: `/repos/${name}`,
    remoteUrl: null,
    defaultBranch: 'main',
  };
}

function history(tabId: string, target: RepoFocusRepo): ChatHistoryItem {
  return {
    tabId,
    title: 'Orchestrator',
    preview: '',
    empty: false,
    messageCount: 1,
    model: 'o8',
    savedAt: '2026-07-19T00:00:00.000Z',
    modifiedAt: '2026-07-19T00:00:00.000Z',
    starred: false,
    pinned: false,
    repoName: target.name,
    repoPath: target.localPath,
  };
}

function runningPacket(id: string, threadId: string, target: RepoFocusRepo): OrchestratorPacket {
  return {
    id,
    title: 'Cross-repo worker',
    status: 'running',
    orchestratorThreadId: threadId,
    workspaceTargetPath: target.localPath,
    lane: { repoPath: target.localPath },
  } as OrchestratorPacket;
}

describe('Spawned agents rail grouping', () => {
  it('keeps a running cross-repo packet in its non-project repo group', () => {
    const projectRepo = repo('project-repo');
    const workerRepo = repo('worker-repo');
    const threadId = 'thoughts-project';
    const packet = runningPacket('pkt-running', threadId, workerRepo);
    const hidden = deriveNestedPacketIds(
      [history(threadId, projectRepo)],
      new Map([[threadId, [packet]]]),
      [projectRepo, workerRepo],
      true,
    );
    const lane: LaneSummary = {
      id: 'lane-running',
      label: 'Cross-repo worker',
      repoPath: workerRepo.localPath,
      branch: 'issue/cross-repo',
      runtime: 'codex',
      sessionKey: 'codex-owned:lane-running',
      packetId: packet.id,
      status: 'running',
      ownership: 'managed',
      lastEventAt: '2026-07-19T00:01:00.000Z',
      lastEventLabel: 'agent_progress',
    };
    const registered: RegisteredRepo[] = [projectRepo, workerRepo];

    expect([...hidden]).toEqual([]);
    expect(deriveSpawnedAgentGroups({
      lanes: [lane],
      agents: [],
      repos: registered,
      hidePacketIds: hidden,
    })).toMatchObject([{
      label: 'worker-repo',
      rows: [{ packetId: 'pkt-running', laneStatus: 'running' }],
    }]);
  });

  it('still deduplicates a worker nested under a same-repo thread', () => {
    const workerRepo = repo('worker-repo');
    const threadId = 'thoughts-worker';
    const packet = runningPacket('pkt-nested', threadId, workerRepo);

    expect([...deriveNestedPacketIds(
      [history(threadId, workerRepo)],
      new Map([[threadId, [packet]]]),
      [workerRepo],
      true,
    )]).toEqual(['pkt-nested']);
  });
});
