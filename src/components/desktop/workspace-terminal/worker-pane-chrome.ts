import type { TerminalTab } from './types';

function cleanLabel(value: string): string {
  const words = value.replace(/\s+/g, ' ').trim().replace(/[:;,\s]+$/g, '').split(' ');
  while (words.length > 1 && /^(a|an|the|to|for|with|and|or|of|in|on|by|from|at|into|via|per)$/i.test(words.at(-1)!)) words.pop();
  return words.join(' ').replace(/[:;,\s]+$/g, '');
}

/** Keep the complete task phrase; the surface handles visual ellipsis. */
export function shortWorkerTitle({ label, branch, fallback = 'Worker' }: {
  label?: string | null; branch?: string | null; fallback?: string;
}): string {
  const task = label?.replace(/^o8\s*[•·]\s*/i, '').trim() ?? '';
  const rawBranch = branch?.trim() ?? '';
  if (task && task !== rawBranch && !/^(inline\/\d+-|issue\/\d+-)/.test(task)) {
    return cleanLabel(task.replace(/^(?:feat|fix|chore|refactor|design|perf|test|docs)(?:\([^)]*\))?:\s*/i, '')) || fallback;
  }
  const source = (rawBranch || task).replace(/^(?:inline|issue)\/\d+-/, '').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return cleanLabel(source.charAt(0).toUpperCase() + source.slice(1)) || fallback;
}

export function workerTabLabels(tabs: readonly TerminalTab[]): string[] {
  const base = tabs.map(tab => tab.orchestrationPacket
    ? shortWorkerTitle({ label: tab.orchestrationPacket.title, branch: tab.orchestrationPacket.branchTarget })
    : shortWorkerTitle({ label: tab.label, fallback: 'Chat' }));
  const labels = tabs.map((tab, index) => {
    if (tab.orchestrationPacket || tab.labelSource === 'user') return base[index];
    const generic = /^(Orchestrator|Assistant|Agent|Chat)$/i.test(base[index]);
    const repeated = base.filter(label => label === base[index]).length > 1;
    if (!generic && !repeated) return base[index];
    const messages = tab.chatMessages ?? [];
    const thread = tab.llmSummary?.trim()
      || [...messages].reverse().find(entry => entry.role === 'user' && entry.text.trim())?.text
      || tab.chatDraftInjection?.text || tab.llmDraftInjection?.text;
    return thread ? shortWorkerTitle({ label: thread }) : base[index];
  });
  return labels.map((label, index) => labels.filter(other => other === label).length > 1
    ? `${label} ${labels.slice(0, index + 1).filter(other => other === label).length}` : label);
}

export function isCompactWorkerPane(width: number, height: number): boolean {
  return width < 480 || height < 360;
}

export interface WorkerAttention { label: string; tone: 'warning' | 'danger' }

export function workerAttention(status?: string | null, blockedReason?: string | null): WorkerAttention | null {
  if (status === 'blocked') return { label: blockedReason && !/^(worker_question|huddle_ready)$/.test(blockedReason)
    ? `Blocked: ${blockedReason.replace(/_/g, ' ')}` : 'Blocked', tone: 'danger' };
  if (/paused|recovering/.test(status ?? '')) return { label: 'Paused', tone: 'warning' };
  if (/awaiting_review|review/.test(status ?? '')) return { label: 'Needs review', tone: 'warning' };
  if (/wait|pending|approval/.test(status ?? '')) return { label: 'Waiting', tone: 'warning' };
  return null;
}
