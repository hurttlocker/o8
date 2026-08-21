import {
  apiFetch,
  errorText,
  jsonResult,
  textResult,
  type McpTool,
  type McpToolResult,
} from './shared';

export const BROADCAST_TOOLS: McpTool[] = [
  {
    name: 'o8_broadcast_token',
    description: 'Mint or revoke a read-only bearer for the live Broadcast spectator surface. A minted bearer is returned once and only its hash is stored.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['mint', 'revoke'] },
        id: { type: 'string', minLength: 1, description: 'Required when action is revoke.' },
        label: { type: 'string', maxLength: 120, description: 'Optional operator label when action is mint.' },
      },
      required: ['action'],
    },
  },
];

export async function handleBroadcastToken(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = args.action;
  if (action !== 'mint' && action !== 'revoke') {
    return textResult('action must be mint or revoke.', true);
  }
  if (action === 'mint' && args.label !== undefined && typeof args.label !== 'string') {
    return textResult('label must be a string.', true);
  }
  if (action === 'revoke' && (typeof args.id !== 'string' || !args.id.trim())) {
    return textResult('id is required when action is revoke.', true);
  }
  try {
    const result = await apiFetch('/api/broadcast/tokens', {
      method: 'POST',
      body: JSON.stringify(action === 'mint'
        ? { action, label: typeof args.label === 'string' ? args.label : undefined }
        : { action, id: (args.id as string).trim() }),
      acceptedErrorStatuses: [404],
    }) as { ok?: boolean };
    return result.ok ? jsonResult(result) : textResult(JSON.stringify(result), true);
  } catch (error) {
    return textResult(`o8_broadcast_token failed: ${errorText(error)}`, true);
  }
}
