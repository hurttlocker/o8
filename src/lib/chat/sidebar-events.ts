import type { AgentSummary } from '@/lib/fleet/types';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';

export type SidebarTranscriptGroup = {
  id: string;
  kind: 'user' | 'agent' | 'system';
  entries: MobileTranscriptEntry[];
};

export type SidebarGroupChipTone = 'blue' | 'purple' | 'amber' | 'emerald' | 'slate';

export type SidebarGroupChip = {
  label: string;
  tone: SidebarGroupChipTone;
};

export type SidebarSourceCard = {
  id: string;
  label: string;
  summary: string;
  details: string[];
  tone: SidebarGroupChipTone;
  links?: Array<{ label: string; href: string }>;
  canOpenDiff?: boolean;
};

export type SidebarRuntimeEventSummary = {
  title: string;
  summary: string;
  status?: string;
  task?: string;
  source?: string;
  changedFiles?: string[];
  action?: string;
  rawPreviewLines?: string[];
};

export type SidebarRuntimeCapabilities = {
  supportsLiveText: boolean;
  supportsToolEvents: boolean;
  supportsSourceCards: boolean;
  supportsApprovals: boolean;
  supportsReasoningSummary: boolean;
};

// Problem C — capability inference per runtime. These checks express real behavioral divergence:
// only codex and claude-code expose live-text streaming, tool events, and approvals from this
// surface layer. gemini/opencode route through different channels. Extend each flag when a new
// runtime ships the corresponding capability. Cannot be collapsed to a label lookup.
export function deriveSidebarRuntimeCapabilities(
  session?: AgentSummary,
): SidebarRuntimeCapabilities {
  const runtime = session?.runtime ?? '';
  const runtimeCapabilities = session?.runtimeSurface?.capabilities;
  const reviewContext = Boolean(session?.runtimeSurface?.capabilities.reviewContext);

  const supportsLiveText = runtime === 'codex'
    || runtime === 'claude-code'
    || Boolean(runtimeCapabilities?.readTail);

  const supportsToolEvents = runtime === 'codex'
    || runtime === 'claude-code'
    || Boolean(runtimeCapabilities?.sendInput);

  const supportsSourceCards = supportsToolEvents || reviewContext;
  const supportsApprovals = runtime === 'codex'
    || runtime === 'claude-code'
    || session?.approvalStatus === 'pending';

  return {
    supportsLiveText,
    supportsToolEvents,
    supportsSourceCards,
    supportsApprovals,
    supportsReasoningSummary: false,
  };
}

export function isSidebarCompactionEntry(entry: MobileTranscriptEntry): boolean {
  return entry.type === 'compaction'
    || (entry.role === 'system' && entry.text.toLowerCase().includes('compaction'));
}

function extractRuntimeField(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'));
  return match?.[1]?.trim() || undefined;
}

function extractRuntimeAction(text: string): string | undefined {
  const match = text.match(/Action:\s*\n([\s\S]+)$/i);
  if (!match?.[1]) return undefined;
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
}

export function firstSidebarString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function parseSidebarRuntimeEventSummary(text: string): SidebarRuntimeEventSummary | null {
  const hasInternalMarkers = /runtime context \(internal\)|begin_untrusted_child_result|task completion event|ready for user delivery/i.test(text);
  if (!hasInternalMarkers) return null;

  const deliveredSpeakerMatch = text.match(/\n([A-Z][A-Z0-9 _-]{1,24})\n[\s\S]{24,}$/);
  if (deliveredSpeakerMatch) return null;

  const task = extractRuntimeField(text, 'task');
  const status = extractRuntimeField(text, 'status');
  const source = extractRuntimeField(text, 'source');
  const rawResult = text.match(/<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>([\s\S]*?)<<<END_UNTRUSTED_CHILD_RESULT>>>/i)?.[1] ?? '';
  const changedFiles = rawResult
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(M|A|D|\?\?)\s+/.test(line))
    .map((line) => line.replace(/^(M|A|D|\?\?)\s+/, ''))
    .slice(0, 4);
  const rawPreviewLines = rawResult
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^index\s/i.test(line))
    .slice(0, 8);

  let summary = 'A sub-agent finished work and queued a handoff into this session.';
  if (/timed out/i.test(status ?? '')) {
    summary = 'A sub-agent timed out and left a handoff package for the current session to deliver.';
  } else if (/completed subagent task/i.test(text)) {
    summary = 'A sub-agent completed work and posted a runtime handoff into the main conversation.';
  }

  return {
    title: task ? `Sub-agent handoff • ${task}` : 'Sub-agent handoff',
    summary,
    status,
    task,
    source,
    changedFiles,
    action: extractRuntimeAction(text),
    rawPreviewLines,
  };
}

export function formatSidebarToolCategory(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes('cortex') || normalized.includes('memory')) return 'cortex';
  if (normalized.includes('read') || normalized.includes('write') || normalized.includes('edit') || normalized === 'ls' || normalized.includes('list_files') || normalized.includes('glob')) return 'file';
  if (normalized.includes('web') || normalized.includes('browser') || normalized.includes('fetch')) return 'web';
  return 'tool';
}

export function sidebarGroupTimeLabel(entries: MobileTranscriptEntry[]): string | undefined {
  const labeled = entries.map((entry) => entry.timestampLabel).filter(Boolean) as string[];
  if (labeled.length === 0) return undefined;
  const first = labeled[0];
  const last = labeled[labeled.length - 1];
  return first === last ? first : `${first} → ${last}`;
}

export function sidebarGroupTimestamp(entries: MobileTranscriptEntry[]): number | undefined {
  return entries.find((entry) => typeof entry.timestamp === 'number')?.timestamp;
}

export function summarizeSidebarAgentGroup(entries: MobileTranscriptEntry[]): {
  chips: SidebarGroupChip[];
  separatorLabel?: string;
  timeLabel?: string;
} {
  const allToolCalls = entries.flatMap((entry) => entry.toolCalls ?? []);
  const runtimeEvents = entries
    .map((entry) => parseSidebarRuntimeEventSummary(entry.text))
    .filter(Boolean) as SidebarRuntimeEventSummary[];

  const chips: SidebarGroupChip[] = [];
  if (runtimeEvents.length > 0) chips.push({ label: 'sub-agent', tone: 'blue' });

  const categories = new Set(allToolCalls.map((tool) => formatSidebarToolCategory(tool.name)));
  const fileOps = allToolCalls.filter((tool) => formatSidebarToolCategory(tool.name) === 'file').length;
  const cortexOps = allToolCalls.filter((tool) => formatSidebarToolCategory(tool.name) === 'cortex').length;
  const webOps = allToolCalls.filter((tool) => formatSidebarToolCategory(tool.name) === 'web').length;
  const changedFiles = runtimeEvents.reduce((sum, event) => sum + (event.changedFiles?.length ?? 0), 0);

  if (cortexOps > 0) chips.push({ label: 'used Cortex', tone: 'purple' });
  if (webOps > 0) chips.push({ label: webOps > 1 ? `${webOps} web steps` : 'web step', tone: 'amber' });
  if (fileOps > 0) chips.push({ label: fileOps > 1 ? `${fileOps} file steps` : 'file step', tone: 'emerald' });
  if (changedFiles > 0) chips.push({ label: `${changedFiles} changed`, tone: 'slate' });
  if (allToolCalls.length > 0 && chips.every((chip) => chip.label !== `${allToolCalls.length} tools`)) {
    chips.push({ label: allToolCalls.length > 1 ? `${allToolCalls.length} tools` : '1 tool', tone: 'slate' });
  }

  let separatorLabel: string | undefined;
  if (entries.length >= 4 || categories.size >= 2 || runtimeEvents.length > 0) {
    separatorLabel = runtimeEvents.length > 0 ? 'handoff run' : 'multi-step run';
  }

  return {
    chips: chips.slice(0, 4),
    separatorLabel,
    timeLabel: sidebarGroupTimeLabel(entries),
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return undefined;
}

export function extractLinksFromText(text: string): Array<{ label: string; href: string }> {
  const links: Array<{ label: string; href: string }> = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const href = normalizeHttpUrl(match[2]);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ label: match[1].trim() || href, href });
  }

  for (const match of text.matchAll(/(^|[\s(])(https?:\/\/[^\s)]+)(?=$|[\s),])/g)) {
    const href = normalizeHttpUrl(match[2]);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ label: href.replace(/^https?:\/\//, ''), href });
  }

  return links;
}

function uniqueLinks(values: Array<{ label: string; href: string }>): Array<{ label: string; href: string }> {
  const seen = new Set<string>();
  const result: Array<{ label: string; href: string }> = [];
  for (const value of values) {
    const href = normalizeHttpUrl(value.href);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    result.push({
      label: value.label.trim() || href.replace(/^https?:\/\//, ''),
      href,
    });
  }
  return result;
}

export function looksLikeSidebarWorkspaceFile(detail: string): boolean {
  if (!detail) return false;
  if (/^https?:\/\//i.test(detail)) return false;
  if (detail.includes(' • ')) return false;
  if (detail.startsWith('stdin:')) return false;
  return detail.includes('/') || /\.[a-z0-9]{1,8}$/i.test(detail);
}

export function buildSidebarSourceCards(entries: MobileTranscriptEntry[]): SidebarSourceCard[] {
  const toolCalls = entries.flatMap((entry) => entry.toolCalls ?? []);
  const runtimeEvents = entries
    .map((entry) => parseSidebarRuntimeEventSummary(entry.text))
    .filter(Boolean) as SidebarRuntimeEventSummary[];

  const cards: SidebarSourceCard[] = [];

  const cortexTools = toolCalls.filter((tool) => formatSidebarToolCategory(tool.name) === 'cortex');
  if (cortexTools.length > 0) {
    const details = uniqueStrings(cortexTools.map((tool) => firstSidebarString(
      tool.args?.query,
      tool.args?.summary,
      tool.args?.path,
    ))).slice(0, 6);
    cards.push({
      id: 'cortex',
      label: 'Cortex',
      summary: details.length > 0 ? `${details.length} recalled signal${details.length !== 1 ? 's' : ''}` : `${cortexTools.length} memory step${cortexTools.length !== 1 ? 's' : ''}`,
      details,
      tone: 'purple',
    });
  }

  const fileTools = toolCalls.filter((tool) => formatSidebarToolCategory(tool.name) === 'file');
  if (fileTools.length > 0) {
    const details = uniqueStrings(fileTools.map((tool) => firstSidebarString(
      tool.args?.file_path,
      tool.args?.path,
      tool.args?.summary,
    ))).slice(0, 8);
    cards.push({
      id: 'files',
      label: 'Files',
      summary: details.length > 0 ? `${details.length} path${details.length !== 1 ? 's' : ''}` : `${fileTools.length} file step${fileTools.length !== 1 ? 's' : ''}`,
      details,
      tone: 'emerald',
      canOpenDiff: true,
    });
  }

  const webTools = toolCalls.filter((tool) => formatSidebarToolCategory(tool.name) === 'web' && tool.name.toLowerCase() !== 'browser');
  if (webTools.length > 0) {
    const textLinks = uniqueLinks(entries.flatMap((entry) => extractLinksFromText(entry.text))).slice(0, 8);
    const toolLinks = uniqueLinks(webTools.flatMap((tool) => {
      const url = normalizeHttpUrl(firstSidebarString(tool.args?.url, tool.args?.href));
      if (!url) return [];
      return [{ label: url.replace(/^https?:\/\//, ''), href: url }];
    }));
    const links = uniqueLinks([...textLinks, ...toolLinks]).slice(0, 8);
    const details = uniqueStrings(webTools.map((tool) => firstSidebarString(
      tool.args?.query,
      tool.args?.url,
      tool.args?.href,
      tool.args?.summary,
    ))).slice(0, 6);
    cards.push({
      id: 'web',
      label: 'Web',
      summary: links.length > 0
        ? `${links.length} source${links.length !== 1 ? 's' : ''}`
        : details.length > 0
          ? `${details.length} lookup${details.length !== 1 ? 's' : ''}`
          : `${webTools.length} web step${webTools.length !== 1 ? 's' : ''}`,
      details,
      tone: 'amber',
      links,
    });
  }

  const browserTools = toolCalls.filter((tool) => tool.name.toLowerCase() === 'browser');
  if (browserTools.length > 0) {
    const links = uniqueLinks(browserTools.flatMap((tool) => {
      const url = normalizeHttpUrl(firstSidebarString(tool.args?.url, tool.args?.href, tool.args?.currentUrl));
      if (!url) return [];
      return [{ label: url.replace(/^https?:\/\//, ''), href: url }];
    })).slice(0, 8);
    const details = uniqueStrings(browserTools.map((tool) => {
      const action = firstSidebarString(tool.args?.action, tool.args?.kind, tool.args?.operation);
      const url = firstSidebarString(tool.args?.url, tool.args?.href, tool.args?.currentUrl);
      if (action && url) return `${action} • ${url}`;
      return action ?? url ?? firstSidebarString(tool.args?.summary);
    })).slice(0, 6);
    cards.push({
      id: 'browser',
      label: 'Browser',
      summary: links.length > 0
        ? `${links.length} page${links.length !== 1 ? 's' : ''}`
        : details.length > 0
          ? `${details.length} observed action${details.length !== 1 ? 's' : ''}`
          : `${browserTools.length} browser step${browserTools.length !== 1 ? 's' : ''}`,
      details,
      tone: 'blue',
      links,
    });
  }

  if (runtimeEvents.length > 0) {
    const details = uniqueStrings(runtimeEvents.flatMap((event) => [
      event.task,
      event.action,
      ...(event.changedFiles ?? []),
    ])).slice(0, 8);
    cards.push({
      id: 'handoff',
      label: 'Handoff',
      summary: runtimeEvents.length > 1 ? `${runtimeEvents.length} queued updates` : 'sub-agent delivery',
      details,
      tone: 'slate',
      canOpenDiff: details.length > 0,
    });
  }

  return cards.slice(0, 4);
}

export function groupSidebarTranscriptTurns(
  transcript: MobileTranscriptEntry[],
): SidebarTranscriptGroup[] {
  const groups: SidebarTranscriptGroup[] = [];
  let pendingAgentGroup: SidebarTranscriptGroup | null = null;

  const flushAgentGroup = () => {
    if (!pendingAgentGroup) return;
    groups.push(pendingAgentGroup);
    pendingAgentGroup = null;
  };

  for (const entry of transcript) {
    if (entry.role === 'user') {
      flushAgentGroup();
      groups.push({ id: entry.id, kind: 'user', entries: [entry] });
      continue;
    }

    if (isSidebarCompactionEntry(entry)) {
      flushAgentGroup();
      groups.push({ id: entry.id, kind: 'system', entries: [entry] });
      continue;
    }

    if (!pendingAgentGroup) {
      pendingAgentGroup = {
        id: `turn-${entry.id}`,
        kind: 'agent',
        entries: [entry],
      };
      continue;
    }

    pendingAgentGroup.entries.push(entry);
  }

  flushAgentGroup();
  return groups;
}

export function activityToSidebarLiveToolCall(
  activity?: AgentSummary['activity'],
): MobileTranscriptToolCall | null {
  if (!activity?.toolName) return null;
  const args: Record<string, unknown> = {};
  if (activity.filePath) args.path = activity.filePath;
  if (!activity.filePath && activity.headline) args.summary = activity.headline;
  return {
    name: activity.toolName,
    args,
    status: 'running',
  };
}

export function lastSidebarTurnToolCalls(
  transcript: MobileTranscriptEntry[],
): MobileTranscriptToolCall[] {
  let lastUserIndex = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  const segment = lastUserIndex >= 0 ? transcript.slice(lastUserIndex + 1) : transcript;
  return segment.flatMap((entry) => (entry.toolCalls ?? []).map((tool) => ({
    ...tool,
    status: tool.status ?? 'done',
  })));
}

export function advanceSidebarToolStack(
  previous: MobileTranscriptToolCall[],
  toolName: string,
): MobileTranscriptToolCall[] {
  const settled = previous.map((tool) => (
    tool.status === 'running' || tool.status === 'calling'
      ? { ...tool, status: 'done' as const }
      : tool
  ));

  return [
    ...settled,
    {
      name: toolName,
      status: 'running',
    },
  ];
}
