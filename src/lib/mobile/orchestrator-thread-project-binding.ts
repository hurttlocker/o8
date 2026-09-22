import type { MobileOrchestratorBackend } from '@/lib/mobile/types';
import { resolveOrchestratorThreadProjectId } from '@/lib/mobile/orchestrator-thread-project';
import {
  modelForBackend,
  normalizeBackend,
  repoNameFromPath,
  type OrchestratorHistoryRecord,
} from '@/lib/mobile/orchestrator-thread-projection';

export interface BindOrchestratorThreadProjectInput {
  tabId: string;
  repoPath: string;
  projectId: unknown;
  backend?: MobileOrchestratorBackend | null;
}

export function buildProjectBoundThreadRecord(
  existing: OrchestratorHistoryRecord | null,
  input: BindOrchestratorThreadProjectInput,
  now = new Date().toISOString(),
): OrchestratorHistoryRecord {
  const backend = input.backend ?? 'claude';
  const record: OrchestratorHistoryRecord = existing ?? {
    messages: [],
    savedAt: now,
    model: modelForBackend(backend) ?? 'claude-code',
    starred: false,
    pinned: false,
    title: null,
    repoPath: input.repoPath,
    repoName: repoNameFromPath(input.repoPath),
    backend,
    agent: null,
    archivedAt: null,
    orchestratorVisible: true,
    orchestratorSessionIds: {},
    orchestratorSessionUpdatedAt: null,
  };
  return {
    ...record,
    projectId: resolveOrchestratorThreadProjectId(record.projectId, input.projectId),
    savedAt: now,
    repoPath: typeof record.repoPath === 'string' && record.repoPath.trim()
      ? record.repoPath
      : input.repoPath,
    repoName: typeof record.repoName === 'string' && record.repoName.trim()
      ? record.repoName
      : repoNameFromPath(input.repoPath),
    backend: normalizeBackend(record.backend) ?? backend,
    orchestratorVisible: true,
  };
}
