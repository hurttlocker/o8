import { randomUUID } from 'node:crypto';

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
    name: 'o8_msg_agents',
    description: 'List live agents and their stable codenames in one repository before sending a peer message.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { repo: { type: 'string', minLength: 1 } },
      required: ['repo'],
    },
  },
  {
    name: 'o8_msg_send',
    description: 'Send a durable, bounded message to an agent in the same repository. Set fromAgentId to the registered sender session for an agent reply, pass the latest message ID as replyToId, and use close for a final reply. Live Claude sessions receive the peer turn directly. Codex receives one coalesced inbox wake. Other runtimes poll their inbox.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', minLength: 1, maxLength: 160 },
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        from: { type: 'string', minLength: 1, maxLength: 160 },
        fromAgentId: { type: 'string', minLength: 1, maxLength: 200 },
        repo: { type: 'string', minLength: 1 },
        laneId: { type: 'string', maxLength: 160 },
        packetId: { type: 'string', maxLength: 160 },
        replyToId: { type: 'string', maxLength: 200 },
        requestId: { type: 'string', maxLength: 200 },
        close: { type: 'boolean' },
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

export async function handleAgentMessageAgents(args: Record<string, unknown>): Promise<McpToolResult> {
  if (typeof args.repo !== 'string' || !args.repo.trim()) return textResult('repo is required.', true);
  try {
    return jsonResult(await apiFetch(`/api/agents/presence?repo=${encodeURIComponent(args.repo.trim())}`));
  } catch (error) {
    return textResult(`o8_msg_agents failed: ${errorText(error)}`, true);
  }
}

export async function handleAgentMessageSend(args: Record<string, unknown>): Promise<McpToolResult> {
  if (typeof args.to !== 'string' || !args.to.trim()) return textResult('to is required.', true);
  if (typeof args.text !== 'string' || !args.text.trim()) return textResult('text is required.', true);
  for (const name of ['from', 'fromAgentId', 'repo', 'laneId', 'packetId', 'replyToId', 'requestId'] as const) {
    if (args[name] !== undefined && typeof args[name] !== 'string') {
      return textResult(`${name} must be a string.`, true);
    }
  }
  if (args.close !== undefined && typeof args.close !== 'boolean') return textResult('close must be a boolean.', true);
  try {
    const result = await apiFetch('/api/agents/message', {
      method: 'POST',
      body: JSON.stringify({
        to: args.to.trim(),
        text: args.text.trim(),
        from: typeof args.from === 'string' ? args.from.trim() : undefined,
        fromAgentId: typeof args.fromAgentId === 'string' ? args.fromAgentId.trim() : undefined,
        repo: typeof args.repo === 'string' ? args.repo.trim() : undefined,
        replyToId: typeof args.replyToId === 'string' ? args.replyToId.trim() : undefined,
        requestId: typeof args.requestId === 'string' ? args.requestId.trim() : randomUUID(),
        close: args.close === true,
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
