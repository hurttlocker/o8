import {
  apiFetch,
  errorText,
  jsonResult,
  optionalString,
  requiredString,
  textResult,
  type McpTool,
  type McpToolResult,
} from './shared';

const TRUTH_KINDS = ['merged-since', 'packet', 'approvals'] as const;
type TruthKind = (typeof TRUTH_KINDS)[number];

export const TRUTH_TOOLS: McpTool[] = [{
  name: 'o8_truth_query',
  description: 'Query signed packet receipts for merged work, packet or issue history, and recorded approvals.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: TRUTH_KINDS },
      repo: { type: 'string', description: 'Repository name or normalized remote for merged-since.' },
      since: { type: 'string', description: 'ISO timestamp for merged-since.' },
      packetId: { type: 'string' },
      issueNumber: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['kind'],
  },
}];

function truthKind(args: Record<string, unknown>): TruthKind {
  const kind = requiredString(args, 'kind');
  if (!TRUTH_KINDS.includes(kind as TruthKind)) {
    throw new Error('kind must be merged-since, packet, or approvals');
  }
  return kind as TruthKind;
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string, maximum?: number): number | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 1 || (maximum !== undefined && Number(value) > maximum)) {
    throw new Error(`${key} must be an integer between 1 and ${maximum ?? Number.MAX_SAFE_INTEGER}`);
  }
  return Number(value);
}

function truthSearchParams(args: Record<string, unknown>): URLSearchParams {
  const kind = truthKind(args);
  const params = new URLSearchParams({ kind });
  const limit = optionalPositiveInteger(args, 'limit', 100);
  if (limit !== null) params.set('limit', String(limit));

  if (kind === 'merged-since') {
    params.set('repo', requiredString(args, 'repo'));
    params.set('since', requiredString(args, 'since'));
    return params;
  }
  const packetId = optionalString(args, 'packetId');
  const issueNumber = optionalPositiveInteger(args, 'issueNumber');
  if (kind === 'packet') {
    if ((!packetId && issueNumber === null) || (packetId && issueNumber !== null)) {
      throw new Error('packet queries require exactly one of packetId or issueNumber');
    }
    if (packetId) params.set('packetId', packetId);
    else params.set('issueNumber', String(issueNumber));
    return params;
  }
  if (!packetId) throw new Error('packetId is required for approvals');
  if (issueNumber !== null) throw new Error('issueNumber is valid only for packet queries');
  params.set('packetId', packetId);
  return params;
}

export async function handleTruthQuery(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const params = truthSearchParams(args);
    return jsonResult(await apiFetch(`/api/orchestrator/truth?${params.toString()}`));
  } catch (error) {
    return textResult(`o8_truth_query failed: ${errorText(error)}`, true);
  }
}
