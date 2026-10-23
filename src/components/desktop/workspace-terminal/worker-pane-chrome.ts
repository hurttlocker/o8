export interface WorkerTabLabelSource {
  label: string;
  labelSource?: 'auto' | 'user';
  orchestrationPacket?: { title?: string | null; branchTarget?: string | null } | null;
  llmSummary?: string | null;
  chatMessages?: readonly { role: string; text: string }[];
  chatDraftInjection?: { text: string } | null;
  llmDraftInjection?: { text: string } | null;
}

const TITLE_WORD_CASE = new Map([
  'CI', 'PR', 'API', 'UI', 'UX', 'MCP', 'CLI', 'ID', 'URL', 'JSON', 'SQL', 'CSS', 'HTML',
  'iOS', 'macOS', 'Linux', 'Windows', 'GitHub', 'npm', 'OAuth', 'SSH', 'TLS', 'VM', 'Tauri', 'Codex', 'Claude', 'o8',
].map(word => [word.toLowerCase(), word]));

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
  const sentence = source.charAt(0).toUpperCase() + source.slice(1);
  return cleanLabel(sentence.replace(/\b[a-z][a-z0-9]*\b/gi, word => TITLE_WORD_CASE.get(word.toLowerCase()) ?? word)) || fallback;
}

export function isGenericWorkerTitle(title: string): boolean {
  return /^(Orchestrator|Assistant|Agent|Chat|Untitled conversation)$/i.test(title.trim())
    || /^Orchestrator session · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(title.trim());
}

/** Broadcast title context without sending transcripts through dashboard state. */
export function workerTabThreadTitle(tab: WorkerTabLabelSource): string | undefined {
  return tab.llmSummary?.trim()
    || [...(tab.chatMessages ?? [])].reverse().find(entry => entry.role === 'user' && entry.text.trim())?.text
    || tab.chatDraftInjection?.text || tab.llmDraftInjection?.text;
}

export function workerTabLabels(tabs: readonly WorkerTabLabelSource[]): string[] {
  const base = tabs.map(tab => tab.orchestrationPacket
    ? shortWorkerTitle({ label: tab.orchestrationPacket.title, branch: tab.orchestrationPacket.branchTarget })
    : shortWorkerTitle({ label: tab.label, fallback: 'Chat' }));
  const labels = tabs.map((tab, index) => {
    if (tab.orchestrationPacket || tab.labelSource === 'user') return base[index];
    const generic = isGenericWorkerTitle(base[index]);
    const repeated = base.filter(label => label === base[index]).length > 1;
    if (!generic && !repeated) return base[index];
    const thread = workerTabThreadTitle(tab);
    return thread ? shortWorkerTitle({ label: thread }) : base[index];
  });
  return labels.map((label, index) => labels.filter(other => other === label).length > 1
    ? `${label} ${labels.slice(0, index + 1).filter(other => other === label).length}` : label);
}

export function isCompactWorkerPane(width: number, height: number): boolean {
  return width < 480 || height < 360;
}

export type WorkerStateAction = 'Resume' | 'Open checks' | 'Open details' | 'Review' | 'Stop';
export interface WorkerAttention { label: string; tone: 'warning' | 'danger'; actions: readonly WorkerStateAction[] }

export function workerAttention(status?: string | null, blockedReason?: string | null): WorkerAttention | null {
  const reason = blockedReason?.trim().replace(/_/g, ' ') ?? '';
  if (status === 'blocked') {
    if (/^(worker question|huddle ready)$/i.test(reason)) return { label: 'Waiting', tone: 'warning', actions: [] };
    if (/^awaiting operator input$/i.test(reason)) return { label: 'Needs review', tone: 'warning', actions: ['Review', 'Stop'] };
    const action = /\b(ci|checks?|build|tests?)\b/i.test(reason) ? 'Open checks' : 'Open details';
    return { label: reason ? `Blocked: ${reason}` : 'Blocked', tone: 'danger', actions: [action, 'Stop'] };
  }
  if (/paused|recovering/.test(status ?? '')) return { label: 'Paused', tone: 'warning', actions: ['Resume', 'Stop'] };
  if (/awaiting_review|review/.test(status ?? '')) return { label: 'Needs review', tone: 'warning', actions: ['Review', 'Stop'] };
  if (/wait|pending|approval/.test(status ?? '')) return { label: 'Waiting', tone: 'warning', actions: [] };
  return null;
}
