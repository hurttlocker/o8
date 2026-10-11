import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { SwarmScoutView } from '../thoughts/chat-panel/SwarmStatusCard';

export function transcriptScouts(entries: MobileTranscriptEntry[], busy: boolean): SwarmScoutView[] {
  const start = entries.findLastIndex(entry => entry.role === 'user');
  const seen = new Set<string>();
  return entries.slice(Math.max(0, start)).flatMap(entry => (entry.toolCalls ?? []).filter(tool => tool.status !== 'error' && /^(?:.*__)?(?:task)$/i.test(tool.name)).map((tool, index) => {
    const args = tool.args ?? {};
    const label = [args.description, args.task_name, args.subagent_type].find(value => typeof value === 'string' && value.trim());
    return { id: tool.id ?? `${entry.id}-scout-${index}`, label: typeof label === 'string' ? label : 'Agent', status: tool.status === 'done' || !busy ? 'done' as const : 'running' as const };
  })).filter(scout => { if (seen.has(scout.id)) return false; seen.add(scout.id); return true; });
}

export function transcriptRunningTools(entries: MobileTranscriptEntry[], busy: boolean, now: number): MobileTranscriptToolCall[] {
  const latest = entries.findLast(entry => entry.role === 'assistant');
  // Restored stale tool calls must not start an endless live timer.
  if (!latest || (!busy && typeof latest.timestamp === 'number' && now - latest.timestamp > 30 * 60 * 1000)) return [];
  return (latest.toolCalls ?? []).filter(tool => tool.status === 'running' || tool.status === 'calling');
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
