import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

export function museRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function museTerminalEvent(params: Record<string, unknown>): OrchestratorEvent {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null;
  if (params.terminal === 'completed') return { type: 'done', sessionId, cost: null };
  const error = museRecord(params.error);
  const code = typeof error.kind === 'string' ? error.kind : undefined;
  const messages: Record<string, string> = {
    authRequired: 'Muse needs sign-in. Open Muse Code and run /login, then retry.',
    modelError: 'Muse could not complete the model request. Check its account and selected model.',
    configError: 'Muse could not use this configuration. Check its provider settings.',
    environmentError: 'Muse could not establish its execution environment.',
  };
  return { type: 'error', code, error: params.terminal === 'cancelled'
    ? 'Muse turn cancelled.' : messages[code ?? ''] ?? 'Muse did not complete this turn. Its session is retained for recovery.' };
}

/** Only decisions the runtime offered are eligible; persistent grants stay in the CLI. */
export function museApprovalChoice(request: Record<string, unknown>, approved: boolean): string | null {
  const choices = Array.isArray(request.availableChoices) ? request.availableChoices.map(museRecord) : [];
  const choice = choices.find(value => typeof value.choiceId === 'string' && (approved
    ? value.decision === 'approved' && value.scope === 'once'
    : ['denied', 'abort', 'timedOut'].includes(String(value.decision))));
  return typeof choice?.choiceId === 'string' ? choice.choiceId : null;
}

/** Maps the root session's view without repeating snapshots after streamed deltas. */
export function createMuseEventMapper(sessionId: string) {
  const items = new Map<string, Record<string, unknown>>();
  const streamed = new Set<string>();
  const started = new Set<string>();
  const completed = new Set<string>();
  return (notification: { method: string; params?: unknown }): OrchestratorEvent[] => {
    const params = museRecord(notification.params);
    if (params.sessionId !== sessionId) return [];
    if (notification.method === 'item/delta') {
      const id = String(params.itemId ?? '');
      const item = items.get(id);
      if (!item || typeof params.delta !== 'string' || !params.delta) return [];
      if (params.field && params.field !== 'text') return [];
      if (!['agentMessage', 'reasoning'].includes(String(item.kind))) return [];
      streamed.add(id);
      return [{ type: item.kind === 'reasoning' ? 'thinking' : 'text', text: params.delta }];
    }
    if (!['item/started', 'item/updated', 'item/completed'].includes(notification.method)) return [];
    const item = museRecord(params.item);
    if (typeof item.itemId !== 'string') return [];
    const id = item.itemId;
    items.set(id, item);
    const finished = !['inProgress', undefined].includes(item.status as string | undefined);
    if (item.kind === 'agentMessage' || item.kind === 'reasoning') {
      if (!finished || streamed.has(id) || completed.has(id) || typeof item.text !== 'string' || !item.text) return [];
      completed.add(id);
      return [{ type: item.kind === 'reasoning' ? 'thinking' : 'text', text: item.text }];
    }
    if (!['toolCall', 'subagent', 'workflow', 'webSearch'].includes(String(item.kind))) return [];
    const name = item.kind === 'subagent' ? `subagent:${String(item.subagentId ?? id)}`
      : typeof item.tool === 'string' ? item.tool : String(item.kind);
    const result: OrchestratorEvent[] = [];
    if (!started.has(id) && !finished) {
      started.add(id);
      let input: unknown = item.args ?? item.objective ?? {};
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* Keep native arguments. */ } }
      result.push({ type: 'tool_use', id, name, input });
    }
    if (finished && !completed.has(id)) {
      completed.add(id);
      result.push({ type: 'tool_result', id, name,
        output: String(item.visibleOutput ?? item.finalSummary ?? item.text ?? item.message ?? ''),
        isError: item.status !== 'completed' || Boolean(item.failureKind) });
    }
    return result;
  };
}
