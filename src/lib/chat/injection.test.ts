import { describe, expect, it } from 'vitest';
import {
  selectRepoOrchestratorConversation,
  type OrchestratorConversationWorkspaceSnapshot,
} from '@/lib/chat/injection';

function workspace(
  tileId: string,
  activeTabId: string,
  tabs: OrchestratorConversationWorkspaceSnapshot['tabs'],
): OrchestratorConversationWorkspaceSnapshot {
  return { tileId, activeTabId, tabs };
}

describe('selectRepoOrchestratorConversation', () => {
  it('continues the preferred thread for the repo even when another tab is newer', () => {
    const target = selectRepoOrchestratorConversation([
      workspace('tile-a', 'orch-newer', [
        {
          id: 'orch-newer',
          kind: 'orchestrator',
          repoPath: '/repo',
          orchestratorThreadId: 'thoughts-newer',
          lastActivity: 200,
          mode: 'fleet',
        },
        {
          id: 'orch-last-used',
          kind: 'orchestrator',
          repoPath: '/repo',
          orchestratorThreadId: 'thoughts-last-used',
          lastActivity: 100,
          mode: 'fleet',
        },
      ]),
    ], '/repo', 'thoughts-last-used');

    expect(target).toEqual({ tileId: 'tile-a', tabId: 'orch-last-used' });
  });

  it('falls back to the active loaded orchestrator and ignores worker or blank tabs', () => {
    const target = selectRepoOrchestratorConversation([
      workspace('tile-a', 'orch-active', [
        {
          id: 'worker',
          kind: 'chat',
          repoPath: '/repo',
          lastActivity: 500,
        },
        {
          id: 'orch-blank',
          kind: 'orchestrator',
          repoPath: '/repo',
          lastActivity: 400,
          mode: 'fleet',
        },
        {
          id: 'orch-active',
          kind: 'orchestrator',
          repoPath: '/repo',
          orchestratorThreadId: 'thoughts-active',
          lastActivity: 100,
          mode: 'fleet',
        },
      ]),
    ], '/repo');

    expect(target).toEqual({ tileId: 'tile-a', tabId: 'orch-active' });
  });

  it('returns null when the repo has no loaded fleet orchestrator conversation', () => {
    const target = selectRepoOrchestratorConversation([
      workspace('tile-a', 'single', [
        {
          id: 'single',
          kind: 'orchestrator',
          repoPath: '/repo',
          orchestratorThreadId: 'thoughts-single',
          lastActivity: 100,
          mode: 'single',
        },
        {
          id: 'other-repo',
          kind: 'orchestrator',
          repoPath: '/other',
          orchestratorThreadId: 'thoughts-other',
          lastActivity: 200,
          mode: 'fleet',
        },
      ]),
    ], '/repo');

    expect(target).toBeNull();
  });
});
