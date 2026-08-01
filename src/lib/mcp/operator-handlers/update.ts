import {
  apiFetch,
  errorText,
  jsonResult,
  textResult,
  type McpTool,
  type McpToolResult,
} from './shared';

export const UPDATE_TOOLS: McpTool[] = [
  {
    name: 'o8_update_apply',
    description: 'Apply the staged or available o8 update through the desktop webview. Refuses while lanes or worker terminals are live unless force is true.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'Override the live-work safety gate. Use only after the operator explicitly accepts an interrupted restart.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

export async function handleUpdateApply(args: Record<string, unknown>): Promise<McpToolResult> {
  if (args.force !== undefined && typeof args.force !== 'boolean') {
    return textResult('force must be boolean', true);
  }
  try {
    const result = await apiFetch('/api/panel/update/apply', {
      method: 'POST',
      body: JSON.stringify({ force: args.force === true }),
      acceptedErrorStatuses: [409, 503],
    }) as { ok?: boolean };
    return { ...jsonResult(result), isError: result.ok !== true };
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_update_apply failed: ${errorText(error)}`);
    return textResult(`Failed to apply update: ${errorText(error)}`, true);
  }
}
