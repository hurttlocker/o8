import {
  apiFetch,
  errorText,
  jsonResult,
  optionalString,
  requiredString,
  type McpTool,
  type McpToolResult,
} from '@/lib/mcp/operator-handlers/shared';

const OBSERVATION_KINDS = new Set(['regression', 'pattern', 'gotcha', 'preference']);
const OBSERVATION_SCOPES = new Set(['packet', 'repo', 'global']);

export const CORTEX_TOOLS: McpTool[] = [
  {
    name: 'cortex_propose_observation',
    description: 'Propose a worker observation for the orchestrator proposal queue. The worker does not write memory directly; the orchestrator reviews and promotes the useful observations.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet ID that produced the observation.',
        },
        kind: {
          type: 'string',
          enum: ['regression', 'pattern', 'gotcha', 'preference'],
          description: 'Observation category.',
        },
        text: {
          type: 'string',
          description: 'Concise observation text for the orchestrator to review.',
        },
        scope: {
          type: 'string',
          enum: ['packet', 'repo', 'global'],
          description: 'Where the observation may apply. Defaults to packet.',
        },
      },
      required: ['packetId', 'kind', 'text'],
    },
  },
];

function parseKind(value: string): string {
  if (OBSERVATION_KINDS.has(value)) return value;
  throw new Error('kind must be one of regression, pattern, gotcha, preference');
}

function parseScope(value: string): string {
  if (!value) return 'packet';
  if (OBSERVATION_SCOPES.has(value)) return value;
  throw new Error('scope must be one of packet, repo, global');
}

export async function handleProposeObservation(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = requiredString(args, 'packetId');
    const kind = parseKind(requiredString(args, 'kind'));
    const text = requiredString(args, 'text');
    const scope = parseScope(optionalString(args, 'scope'));
    const result = await apiFetch('/api/cortex/proposals', {
      method: 'POST',
      body: JSON.stringify({
        action: 'propose_observation',
        packetId,
        kind,
        text,
        scope,
        proposed_by: packetId,
      }),
    }) as Record<string, unknown>;

    if (result.ok) return jsonResult(result);
    return jsonResult({ ok: false, error: result.error ?? 'Unable to propose observation.' });
  } catch (error) {
    return jsonResult({ ok: false, error: errorText(error) });
  }
}
