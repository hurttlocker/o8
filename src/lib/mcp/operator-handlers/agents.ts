import {
  apiFetch,
  errorText,
  jsonResult,
  textResult,
  type McpTool,
  type McpToolResult,
} from './shared';

export const AGENT_MESSAGE_TOOLS: McpTool[] = [
  {
    name: 'o8_msg_send',
    description: 'Send a durable message to an agent in the same repository. Live Claude sessions receive the peer turn directly. Codex receives one coalesced inbox wake. Other runtimes poll their inbox.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', minLength: 1, maxLength: 160 },
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        from: { type: 'string', minLength: 1, maxLength: 160 },
        repo: { type: 'string', minLength: 1 },
        laneId: { type: 'string', maxLength: 160 },
        packetId: { type: 'string', maxLength: 160 },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'o8_msg_inbox',
    description: 'Read one agent inbox as an operator view using its opaque cursor. This does not acknowledge delivery for the target session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', minLength: 1, maxLength: 160 },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['agent'],
    },
  },
];

export async function handleAgentMessageSend(args: Record<string, unknown>): Promise<McpToolResult> {
  if (typeof args.to !== 'string' || !args.to.trim()) return textResult('to is required.', true);
  if (typeof args.text !== 'string' || !args.text.trim()) return textResult('text is required.', true);
  for (const name of ['from', 'repo', 'laneId', 'packetId'] as const) {
    if (args[name] !== undefined && typeof args[name] !== 'string') {
      return textResult(`${name} must be a string.`, true);
    }
  }
  try {
    const result = await apiFetch('/api/agents/message', {
      method: 'POST',
      body: JSON.stringify({
        to: args.to.trim(),
        text: args.text.trim(),
        from: typeof args.from === 'string' ? args.from.trim() : undefined,
        repo: typeof args.repo === 'string' ? args.repo.trim() : undefined,
        refs: {
          laneId: typeof args.laneId === 'string' ? args.laneId.trim() : undefined,
          packetId: typeof args.packetId === 'string' ? args.packetId.trim() : undefined,
        },
      }),
    });
    return jsonResult(result);
  } catch (error) {
    return textResult(`o8_msg_send failed: ${errorText(error)}`, true);
  }
}

export async function handleAgentMessageInbox(args: Record<string, unknown>): Promise<McpToolResult> {
  if (typeof args.agent !== 'string' || !args.agent.trim()) return textResult('agent is required.', true);
  if (args.cursor !== undefined && typeof args.cursor !== 'string') return textResult('cursor must be a string.', true);
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) {
    return textResult('limit must be an integer from 1 through 100.', true);
  }
  const query = new URLSearchParams({ agent: args.agent.trim() });
  if (typeof args.cursor === 'string' && args.cursor.trim()) query.set('cursor', args.cursor.trim());
  if (typeof args.limit === 'number') query.set('limit', String(args.limit));
  try {
    return jsonResult(await apiFetch(`/api/agents/inbox?${query.toString()}`));
  } catch (error) {
    return textResult(`o8_msg_inbox failed: ${errorText(error)}`, true);
  }
}
