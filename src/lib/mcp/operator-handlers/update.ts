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
    description: 'Check or apply an o8 update through the native scheduler. checkOnly requests a fresh check without installing; checkNow checks before applying. Reports check age, preserves parked lanes, and refuses live work unless force is true.',
    inputSchema: {
      type: 'object',
      properties: {
        checkOnly: { type: 'boolean', description: 'Request a fresh native check and report its result without applying an update.' },
        checkNow: { type: 'boolean', description: 'Request a fresh native check before applying, even if the previous check is recent.' },
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
  for (const field of ['checkNow', 'checkOnly']) {
    if (args[field] !== undefined && typeof args[field] !== 'boolean') return textResult(`${field} must be boolean`, true);
  }
  if (args.force !== undefined && typeof args.force !== 'boolean') {
    return textResult('force must be boolean', true);
  }
  try {
    const result = await apiFetch('/api/panel/update/apply', {
      method: 'POST',
      body: JSON.stringify({ force: args.force === true,
        ...(args.checkNow === undefined ? {} : { checkNow: args.checkNow }),
        ...(args.checkOnly === undefined ? {} : { checkOnly: args.checkOnly }) }),
      acceptedErrorStatuses: [409, 503],
      timeoutMs: 35_000,
    }) as { ok?: boolean };
    return { ...jsonResult(result), isError: result.ok !== true };
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_update_apply failed: ${errorText(error)}`);
    return textResult(`Failed to apply update: ${errorText(error)}`, true);
  }
}
