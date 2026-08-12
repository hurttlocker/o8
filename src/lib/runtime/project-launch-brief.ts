import type { RuntimeLaunchRequest } from '@/lib/runtime/actions';
import { buildProjectTaskBrief, getProjectContext, type ProjectContext } from '@/lib/projects/context';
import { buildProjectBriefPromptV1 } from '@/lib/prompts/v1';

const PROJECT_BRIEF_HEADING_PATTERN = /(?:^|\n)##\s+Project Brief\b/i;

export function summarizeTaskName(prompt: string) {
  const lines = prompt.split('\n').map((line) => line.trim()).filter(Boolean);
  const headingPattern = /^#{1,6}\s+\S/;
  const listPattern = /^[-*]\s+\S|^\d+\.\s+\S/;
  const firstContent = lines.find((line) => !headingPattern.test(line) && !listPattern.test(line))
    ?? lines.find(Boolean)
    ?? 'agent-task';
  return firstContent
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

export async function buildLaunchPromptWithProjectBrief(
  payload: RuntimeLaunchRequest,
  prompt: string,
  repoPath: string,
): Promise<{ prompt: string; projectContext: ProjectContext | null }> {
  const contextRepoPath = payload.projectRepoPath?.trim() || repoPath;
  let projectContext: ProjectContext | null = null;
  try {
    projectContext = await getProjectContext({ repoPath: contextRepoPath });
  } catch (error) {
    console.warn('[runtime-actions] Project context unavailable for launch:', error instanceof Error ? error.message : error);
  }
  if (PROJECT_BRIEF_HEADING_PATTERN.test(prompt) || !projectContext) return { prompt, projectContext };
  const projectBrief = buildProjectTaskBrief(projectContext, {
    repoPath: contextRepoPath,
    taskTitle: payload.taskName?.trim() || summarizeTaskName(prompt),
    taskBody: prompt,
  });
  return { projectContext, prompt: buildProjectBriefPromptV1(projectBrief, prompt) };
}
