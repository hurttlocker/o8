import { getTaskPool } from '@/lib/tasks/pool';
import { projectTaskPool } from '@/lib/mcp/operator-handlers/response-projections';
import { errorText, jsonResult, optionalString, textResult, type McpTool, type McpToolResult } from '@/lib/mcp/operator-handlers/shared';

export const TASK_LIST_TOOL: McpTool = {
  name: 'o8_task_list',
  description:
    'Return compact tasks once, with ready/running/review/blocked/done groups containing task ids. Pass includeDetails for full task metadata, or use o8_task_brief for one task. This projects packets and lanes, not a separate task store. Use it before claiming or dispatching work.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Optional project id or slug filter.',
      },
      repoPath: {
        type: 'string',
        description: 'Optional absolute repo path filter.',
      },
      includeDone: {
        type: 'boolean',
        description: 'Include released/completed/archived tasks. Default false.',
      },
      includeBrief: {
        type: 'boolean',
        description: 'Include full project-backed task briefs on each task. Default false; prefer o8_task_brief for one task.',
      },
      includeDetails: { type: 'boolean', description: 'Include full task metadata. Default false; groups always contain task ids.' },
    },
  },
};

export async function handleTaskList(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectId = optionalString(args, 'projectId') || null;
    const repoPath = optionalString(args, 'repoPath') || null;
    const includeDone = args.includeDone === true;
    const includeBrief = args.includeBrief === true;
    const result = await getTaskPool({ projectId, repoPath, includeDone, includeBrief });
    return jsonResult(projectTaskPool(result, args.includeDetails === true || includeBrief));
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_list failed: ${errorText(error)}`);
    return textResult(`Failed to read task pool: ${errorText(error)}`, true);
  }
}
