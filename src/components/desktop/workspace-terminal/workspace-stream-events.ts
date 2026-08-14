import type { ClaudeCodeStreamJsonChatEvent } from '@/lib/claude-code/stream-json-parser';

export type ClaudePermissionDecision = 'approve' | 'deny';

export interface WorkspaceStreamEvent {
  type: string;
  id?: string | null;
  name?: string;
  status?: 'calling' | 'running' | 'done' | 'pending' | 'active' | 'complete';
  args?: Record<string, unknown>;
  preview?: string;
  output?: string;
  text?: string;
  sessionId?: string;
  threadId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  factCount?: number;
  sources?: Array<{ title: string; url?: string; path?: string; index?: number }>;
}

export type WorkspaceUsageTokens = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

export function workspaceUsageTokens(
  event: WorkspaceStreamEvent,
  fallback?: WorkspaceUsageTokens,
): WorkspaceUsageTokens | undefined {
  if (![event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens].some((value) => typeof value === 'number')) return fallback;
  return {
    input: event.inputTokens ?? fallback?.input ?? 0,
    output: event.outputTokens ?? fallback?.output ?? 0,
    ...(typeof event.cacheReadTokens === 'number' ? { cacheRead: event.cacheReadTokens } : {}),
    ...(typeof event.cacheWriteTokens === 'number' ? { cacheWrite: event.cacheWriteTokens } : {}),
  };
}

function normalizeStatus(status: WorkspaceStreamEvent['status']) {
  return status === 'calling' || status === 'running' || status === 'done' ? status : undefined;
}

function normalizePlanStatus(status: WorkspaceStreamEvent['status']) {
  return status === 'pending' || status === 'active' || status === 'complete' ? status : undefined;
}

function sameEvent(left: ClaudeCodeStreamJsonChatEvent, right: ClaudeCodeStreamJsonChatEvent) {
  if (left.type !== right.type) return false;
  if ('id' in left && 'id' in right && left.id && right.id) return left.id === right.id;
  if (left.type === 'plan_step' && right.type === 'plan_step') return left.text === right.text;
  if (left.type === 'permission_request' && right.type === 'permission_request') return left.text === right.text;
  if (left.type === 'tool_call' && right.type === 'tool_call') return left.name === right.name && left.preview === right.preview;
  return false;
}

export function mergeClaudeCodeChatEvent(
  events: ClaudeCodeStreamJsonChatEvent[],
  event: ClaudeCodeStreamJsonChatEvent,
): ClaudeCodeStreamJsonChatEvent[] {
  const index = events.findIndex((candidate) => sameEvent(candidate, event));
  if (index < 0) return [...events, event];
  return events.map((candidate, candidateIndex) => (
    candidateIndex === index ? { ...candidate, ...event } as ClaudeCodeStreamJsonChatEvent : candidate
  ));
}

export function coerceClaudeCodeChatEvent(event: WorkspaceStreamEvent): ClaudeCodeStreamJsonChatEvent | null {
  if (event.type === 'usage') {
    return {
      type: 'usage',
      inputTokens: event.inputTokens ?? 0,
      outputTokens: event.outputTokens ?? 0,
      ...(typeof event.cacheReadTokens === 'number' ? { cacheReadTokens: event.cacheReadTokens } : {}),
      ...(typeof event.cacheWriteTokens === 'number' ? { cacheWriteTokens: event.cacheWriteTokens } : {}),
      ...(typeof event.costUsd === 'number' ? { costUsd: event.costUsd } : {}),
    };
  }

  if (event.type === 'tool_call' && event.name) {
    return {
      type: 'tool_call',
      id: event.id ?? null,
      name: event.name,
      status: normalizeStatus(event.status) ?? 'running',
      ...(event.args ? { args: event.args } : {}),
      ...(event.preview ? { preview: event.preview } : {}),
    };
  }

  if (event.type === 'tool_result') {
    return {
      type: 'tool_result',
      id: event.id ?? null,
      name: event.name,
      ...(event.args ? { args: event.args } : {}),
      ...(event.output ? { output: event.output } : {}),
      ...(event.preview ? { preview: event.preview } : {}),
    };
  }

  if (event.type === 'plan_step' && event.text) {
    return {
      type: 'plan_step',
      id: event.id ?? null,
      text: event.text,
      ...(normalizePlanStatus(event.status) ? { status: normalizePlanStatus(event.status) } : {}),
    };
  }

  if (event.type === 'permission_request' && event.text) {
    return {
      type: 'permission_request',
      id: event.id ?? null,
      name: event.name,
      text: event.text,
      ...(event.args ? { args: event.args } : {}),
    };
  }

  return null;
}

export function buildClaudePermissionDecisionMessage(
  request: Extract<ClaudeCodeStreamJsonChatEvent, { type: 'permission_request' }>,
  decision: ClaudePermissionDecision,
) {
  const toolLabel = request.name ? ` for ${request.name}` : '';
  if (decision === 'approve') {
    return [
      `Approved permission request${toolLabel}.`,
      request.text,
      'Exit plan mode and continue with the requested changes.',
    ].filter(Boolean).join('\n\n');
  }

  return [
    `Denied permission request${toolLabel}.`,
    request.text,
    'Do not make those changes. Revise the plan or ask before proceeding.',
  ].filter(Boolean).join('\n\n');
}
