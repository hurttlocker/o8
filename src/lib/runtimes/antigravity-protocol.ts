import type { OwnedRunRecord, OwnedTailEntry, ParsedRunLog } from './shared/owned-session';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Official init/step_update/result stream; result usage is cumulative per conversation. */
export function parseAntigravityRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog {
  const timestamp = run.finishedAt ?? run.startedAt;
  const entries: OwnedTailEntry[] = [{
    id: `${run.id}:prompt`, kind: 'event', label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
    text: run.prompt, timestamp: run.startedAt,
  }];
  const steps = new Map<number, OwnedTailEntry>();
  let threadId: string | undefined;
  let status: string | undefined;
  let response: string | undefined;
  for (const line of raw.split('\n')) {
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(line)); } catch { continue; }
    if (event.event === 'init' && typeof event.conversation_id === 'string') threadId = event.conversation_id;
    if (event.event === 'step_update') {
      const step = record(event.step_update);
      if (typeof step.step_index !== 'number') continue;
      const id = `${run.id}:step:${step.step_index}`;
      if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
        steps.set(step.step_index, {
          id, kind: 'message', label: 'Antigravity', timestamp,
          text: (steps.get(step.step_index)?.text ?? '') + step.text_delta,
        });
      } else if (step.step_type === 'tool') {
        const tool = record(step.tool_info);
        steps.set(step.step_index, {
          id, kind: 'tool', label: String(step.tool_name ?? tool.name ?? 'Tool'), timestamp,
          text: JSON.stringify(tool),
        });
      }
    }
    if (event.event === 'result') {
      const result = record(event.result);
      if (typeof result.conversation_id === 'string' && result.conversation_id) threadId = result.conversation_id;
      status = typeof result.status === 'string' ? result.status : 'INVALID';
      if (typeof result.response === 'string') response = result.response;
      if (Array.isArray(result.denied_actions) && result.denied_actions.length > 0) {
        status = 'PERMISSION_DENIED';
      }
      if (status !== 'SUCCESS') entries.push({
        id: `${run.id}:error`, kind: 'event', label: 'Error',
        text: typeof result.error === 'string' ? result.error : `Run ended with ${status}.`, timestamp,
      });
    }
  }
  entries.push(...steps.values());
  if (response && ![...steps.values()].some(e => e.kind === 'message')) {
    entries.push({ id: `${run.id}:response`, kind: 'message', label: 'Antigravity', text: response, timestamp });
  }
  const completedTurn = status === 'SUCCESS';
  const outcome = status === 'INTERRUPTED' || status === 'CANCELED' || run.interruptRequestedAt
    ? 'interrupted'
    : status && !completedTurn ? 'failed'
    : completedTurn ? 'finished'
    : run.childExit || run.finishedAt || run.outcome === 'finished' || run.outcome === 'failed' ? 'failed' : run.outcome;
  return { threadId, entries, completedTurn, outcome };
}
