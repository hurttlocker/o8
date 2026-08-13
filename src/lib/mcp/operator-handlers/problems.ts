import { listProblemDossiers, listProblemRemedies } from '@/lib/problems/dossiers';
import { projectProblemDossierMetrics } from '@/lib/problems/metrics';
import { reconcileProblemDossiers } from '@/lib/problems/service';
import { jsonResult, textResult, type McpTool, type McpToolResult } from './shared';

export const PROBLEM_TOOLS: McpTool[] = [
  {
    name: 'o8_problem_list',
    description: 'List recurring engineering problems correlated across independent packets, including remedy and verified-closure state.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Optional project id filter.' },
        repoPath: { type: 'string', description: 'Optional exact repo path filter.' },
        includeSuppressed: { type: 'boolean', description: 'Include suppressed and operator-stopped dossiers.' },
      },
    },
  },
  {
    name: 'o8_problem_get',
    description: 'Read one recurring-problem dossier with immutable evidence, linked task, remedies, and closure progress.',
    inputSchema: {
      type: 'object',
      properties: {
        dossierId: { type: 'string', description: 'Stable problem dossier id.' },
      },
      required: ['dossierId'],
    },
  },
];

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function project(dossier: ReturnType<typeof listProblemDossiers>[number]) {
  return { ...dossier, remedies: listProblemRemedies(dossier.id) };
}

export async function handleProblemList(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectId = optionalString(args, 'projectId');
    const repoPath = optionalString(args, 'repoPath');
    await reconcileProblemDossiers({ projectId });
    const dossiers = listProblemDossiers({ projectId, includeSuppressed: args.includeSuppressed === true })
      .filter((dossier) => !repoPath || dossier.repoPath === repoPath)
      .map(project);
    return jsonResult({
      schema: 'o8/problem-dossiers/v1',
      dossiers,
      metrics: projectProblemDossierMetrics(dossiers),
    });
  } catch (error) {
    return textResult(`Failed to read problem dossiers: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

export async function handleProblemGet(args: Record<string, unknown>): Promise<McpToolResult> {
  const dossierId = optionalString(args, 'dossierId');
  if (!dossierId) return textResult('dossierId is required.', true);
  try {
    await reconcileProblemDossiers();
    const dossier = listProblemDossiers({ includeSuppressed: true })
      .find((candidate) => candidate.id === dossierId);
    return dossier
      ? jsonResult(project(dossier))
      : textResult(`Problem dossier not found: ${dossierId}`, true);
  } catch (error) {
    return textResult(`Failed to read problem dossier: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}
