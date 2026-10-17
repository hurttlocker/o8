import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { SwarmScoutView } from '../thoughts/chat-panel/SwarmStatusCard';

export function transcriptScouts(entries: MobileTranscriptEntry[], busy: boolean): SwarmScoutView[] {
  const start = entries.findLastIndex(entry => entry.role === 'user');
  const scouts = new Map<string, SwarmScoutView>();
  for (const entry of entries.slice(Math.max(0, start))) {
    for (const [index, tool] of (entry.toolCalls ?? []).entries()) {
      if (!/^(?:.*__)?(?:task|agent)$/i.test(tool.name)) continue;
      const args = tool.args ?? {};
      const label = [args.description, args.task_name, args.subagent_type].find(value => typeof value === 'string' && value.trim());
      const id = tool.id ?? `${entry.id}-scout-${index}`;
      // A background launch receipt or an ended parent turn cannot prove the
      // child finished. Keep that evidence gap visible instead of reporting Done.
      const status: SwarmScoutView['status'] = tool.status === 'error' ? 'failed'
        : tool.status === 'stopped' ? 'stopped'
          : tool.status === 'done' ? args.run_in_background === true ? 'unknown' : 'done'
            : busy && (tool.status === 'running' || tool.status === 'calling') ? 'running' : 'unknown';
      scouts.set(id, { id, label: typeof label === 'string' ? label : 'Agent', status });
    }
  }
  return [...scouts.values()];
}

export function transcriptRunningTools(entries: MobileTranscriptEntry[], busy: boolean, now: number): MobileTranscriptToolCall[] {
  const latest = entries.findLast(entry => entry.role === 'assistant');
  // Restored stale tool calls must not start an endless live timer.
  if (!latest || (!busy && typeof latest.timestamp === 'number' && now - latest.timestamp > 30 * 60 * 1000)) return [];
  return (latest.toolCalls ?? []).filter(tool => tool.status === 'running' || tool.status === 'calling');
}

/**
 * The operator pressed Stop: the latest reply's in-flight calls end as stopped
 * at once, so no row or timer keeps running for a turn that is over (#3659).
 */
export function stopRunningTools(entries: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  const index = entries.findLastIndex(entry => entry.role === 'assistant');
  const tools = index < 0 ? [] : entries[index].toolCalls ?? [];
  if (!tools.some(tool => tool.status === 'running' || tool.status === 'calling')) return entries;
  const next = [...entries];
  next[index] = { ...entries[index], toolCalls: tools.map(tool => (
    tool.status === 'running' || tool.status === 'calling' ? { ...tool, status: 'stopped' as const } : tool
  )) };
  return next;
}

export function transcriptPlan(entries: MobileTranscriptEntry[]) {
  for (const entry of [...entries].reverse()) for (const tool of [...entry.toolCalls ?? []].reverse()) {
    if (tool.status === 'error' || !/^(?:.*__)?(?:update_plan|todowrite)$/i.test(tool.name)) continue;
    const plan = tool.args?.plan ?? tool.args?.todos;
    if (!Array.isArray(plan)) continue;
    return plan.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const text = item.step ?? item.content;
      return typeof text === 'string' && ['pending', 'in_progress', 'completed'].includes(item.status)
        ? [{ text, status: item.status as string }] : [];
    });
  }
  return [];
}
