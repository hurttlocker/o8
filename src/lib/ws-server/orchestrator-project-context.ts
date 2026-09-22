import { readFile } from 'node:fs/promises';

import { safeOrchestratorHistoryPath } from '@/lib/mobile/orchestrator-thread-history';
import { resolveOrchestratorThreadProjectId } from '@/lib/mobile/orchestrator-thread-project';
import { buildProjectTaskBrief, getProjectContext, type ProjectContext } from '@/lib/projects/context';
import { buildProjectBriefPromptV1 } from '@/lib/prompts/v1';

export interface OrchestratorProjectSelection {
  projectId: string | null;
  repoPath: string | null;
}

export interface PreparedOrchestratorProjectTurn {
  message: string;
  projectContext: ProjectContext | null;
}

export async function readPersistedOrchestratorProjectSelection(
  threadId: string | null | undefined,
): Promise<OrchestratorProjectSelection | null> {
  if (!threadId?.trim()) return null;
  try {
    const record = JSON.parse(
      await readFile(safeOrchestratorHistoryPath(threadId), 'utf8'),
    ) as { projectId?: unknown; repoPath?: unknown };
    return {
      projectId: typeof record.projectId === 'string' && record.projectId.trim()
        ? record.projectId.trim()
        : null,
      repoPath: typeof record.repoPath === 'string' && record.repoPath.trim()
        ? record.repoPath.trim()
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * Add the selected project's brief to the model payload only. Callers must keep
 * the original operator text for transcript persistence and display.
 */
export async function prepareOrchestratorProjectTurn(input: {
  message: string;
  persistedProjectId?: unknown;
  requestedProjectId?: unknown;
  repoPath: string | null | undefined;
}): Promise<PreparedOrchestratorProjectTurn> {
  const projectId = resolveOrchestratorThreadProjectId(
    input.persistedProjectId,
    input.requestedProjectId,
  );
  if (!projectId) return { message: input.message, projectContext: null };

  const repoPath = input.repoPath?.trim() || null;
  const projectContext = await getProjectContext({ projectId, repoPath });
  const projectBrief = buildProjectTaskBrief(projectContext, { repoPath });
  return {
    message: buildProjectBriefPromptV1(projectBrief, input.message),
    projectContext,
  };
}
