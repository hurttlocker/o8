export const PROJECT_BRIEF_HEADING_V1 = '## Project Brief';
export const TASK_HEADING_V1 = '## Task';

export function buildProjectBriefPromptV1(projectBrief: string, task: string): string {
  return [
    PROJECT_BRIEF_HEADING_V1,
    projectBrief,
    TASK_HEADING_V1,
    task,
  ].join('\n\n');
}
