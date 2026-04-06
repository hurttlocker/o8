import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';
import {
  activityToSidebarLiveToolCall as normalizeActivityToSidebarLiveToolCall,
  advanceSidebarToolStack as normalizeAdvanceSidebarToolStack,
  buildSidebarSourceCards as normalizeSidebarSourceCards,
  groupSidebarTranscriptTurns as normalizeSidebarTranscriptTurns,
  looksLikeSidebarWorkspaceFile as normalizeSidebarWorkspaceFile,
  parseSidebarRuntimeEventSummary as normalizeSidebarRuntimeEventSummary,
  sidebarGroupTimestamp as normalizeSidebarGroupTimestamp,
  summarizeSidebarAgentGroup as normalizeSidebarAgentGroup,
  lastSidebarTurnToolCalls as normalizeLastSidebarTurnToolCalls,
} from '@/lib/chat/sidebar-events';
import { formatModelLabel } from '@/lib/format';
import {
  adHocLaneTitle,
  normalizeRuntimeStatusToOrchestratorStatus,
  orchestratorRuntimeTone,
  orchestratorStatusTone,
} from '@/lib/orchestrator/display';
import { INTERNAL_PROTOCOL_TAGS, OPERATOR_COLLAPSE_MARKERS } from './constants';
import type {
  ChatStarterPrompt,
  GroupChip,
  GroupChipTone,
  GroupSourceCard,
  RuntimeEventSummary,
  SessionPickerChip,
  SessionPickerChipTone,
  SessionSummary,
  TranscriptGroup,
} from './types';

// ── Performance: snapshot fingerprint (replaces JSON.stringify equality) ──
export function snapshotFp(data: MobileInboxSnapshot | null): string {
  if (!data) return '';
  const sessions = data.sessions ?? [];
  return `${sessions.length}|${sessions.map((s) => `${s.sessionKey}:${s.status}`).join(',')}`;
}

export function sessionsFp(sessions: SessionSummary[]): string {
  return `${sessions.length}|${sessions.map((s) => `${s.sessionKey}:${s.status}`).join(',')}`;
}

// ── Performance: targeted transcript entry update (replaces full .map() scan) ──
export function updateTranscriptEntry(
  prev: MobileTranscriptEntry[],
  targetId: string,
  patch: Partial<MobileTranscriptEntry>,
): MobileTranscriptEntry[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].id === targetId) {
      const updated = { ...prev[i], ...patch };
      const next = prev.slice();
      next[i] = updated;
      return next;
    }
  }
  return prev;
}

// ── Session helpers ──
export function getAgentName(s: SessionSummary): string {
  if (s.orchestrationPacket?.title?.trim()) return s.orchestrationPacket.title.trim();
  if (s.runtime === 'claude-code') return 'Claude Code';
  if (s.isCurrentSession) return 'Assistant';
  const name = s.name || s.sessionKey;
  if (name.includes('codex-owned')) return 'Codex';
  if (name.includes('ace')) return 'Niot';
  if (name.includes('hawk')) return 'Hawk';
  return name;
}

export function sessionDisplayModel(session?: SessionSummary) {
  if (!session) return 'Live';
  if (session.runtime === 'chat') {
    return formatModelLabel(session.model ?? 'Workspace Chat');
  }
  if (session.runtime === 'codex') {
    return formatModelLabel(session.model ?? 'Codex');
  }
  if (session.runtime === 'claude-code') {
    return formatModelLabel(session.model ?? 'Claude Code');
  }
  return formatModelLabel(session.model ?? 'Live');
}

export function roleLabel(role: string, agentName?: string): string {
  if (role === 'user') return 'You';
  if (role === 'system') return 'System';
  return agentName ?? 'Assistant';
}

export function compactLine(text: string | null | undefined, fallback: string, max = 26): string {
  const val = text ?? fallback;
  if (val.length <= max) return val;
  return val.slice(0, max - 1) + '\u2026';
}

export function sessionLocalFolderLabel(session: SessionSummary) {
  const cwd = session.runtimeSurface?.cwd?.trim() || session.workspace?.trim();
  if (!cwd) return null;
  const sourceLabel = session.runtimeSurface?.sourceLabel ?? '';
  const ttyMatch = sourceLabel.match(/(?:^|• )([st]tys?\d{3}|s\d{3})(?: •|$)/i);
  const tty = ttyMatch?.[1]?.trim();
  const folder = compactLine(cwd, cwd, 44);
  return tty ? `${folder} \u2022 ${tty}` : folder;
}

export function sessionRuntimeLabel(session: SessionSummary) {
  if (session.orchestrationPacket?.runtime) {
    return orchestratorRuntimeTone(session.orchestrationPacket.runtime).label;
  }
  if (session.runtime === 'claude-code') return 'Claude Code';
  if (session.runtime === 'codex') return 'Codex';
  if (session.runtime === 'chat') return 'Chat';
  return 'Session';
}

export function sessionRepoLabel(session: SessionSummary) {
  const repoSlug = session.runtimeSurface?.reviewContext?.repoSlug?.split('/').pop()?.trim();
  if (repoSlug) return repoSlug;
  const cwd = session.runtimeSurface?.cwd?.trim() || session.workspace?.trim();
  if (!cwd) return null;
  const normalized = cwd.replace(/^~\//, '').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

export function cleanBranchLabel(branch?: string | null) {
  const trimmed = branch?.trim();
  if (!trimmed || trimmed === 'unknown') return null;
  return trimmed.replace(/^(feat|fix|batch|chore|refactor)\//, '');
}

export function sessionLaneTitle(session?: SessionSummary) {
  if (!session) return 'Choose a lane';
  if (session.orchestrationPacket?.title?.trim()) {
    return session.orchestrationPacket.title.trim();
  }
  if (session.runtime === 'chat' || session.runtime === 'codex' || session.runtime === 'claude-code') {
    return adHocLaneTitle('chat');
  }
  return adHocLaneTitle('terminal');
}

export function sessionTaskLabel(session?: SessionSummary) {
  if (!session) return null;
  if (session.orchestrationPacket?.referenceLabel) {
    return session.orchestrationPacket.referenceLabel;
  }
  const candidates = [
    session.name,
    session.currentTask,
    session.activity?.headline,
  ]
    .map((value) => sanitizeTranscriptText(value ?? ''))
    .filter((value): value is string => Boolean(value.trim()));

  for (const candidate of candidates) {
    const issueMatch = candidate.match(/\bIssue #\d+\b/i);
    if (issueMatch) return issueMatch[0].replace(/^issue/i, 'Issue');
    const prMatch = candidate.match(/\bPR #\d+\b/i);
    if (prMatch) return prMatch[0].replace(/^pr/i, 'PR');
    if (/review/i.test(candidate)) return 'Review';
  }

  return null;
}

export function sessionTaskSummary(session?: SessionSummary, max = 42) {
  if (!session) return null;
  const taskSummary = sanitizeTranscriptText(session.currentTask?.trim() ?? '');
  if (!taskSummary) return null;
  if (/^(hi|hey|hello|good (morning|afternoon|evening))\b/i.test(taskSummary)) return null;
  return compactLine(taskSummary, taskSummary, max);
}

export function sessionStateChip(session?: SessionSummary): SessionPickerChip | null {
  if (!session) return null;
  const canonical = session.orchestrationPacket
    ? orchestratorStatusTone(session.orchestrationPacket.status)
    : orchestratorStatusTone(normalizeRuntimeStatusToOrchestratorStatus(session.status));
  const tone: SessionPickerChipTone = canonical.label === 'Running'
    ? 'green'
    : canonical.label === 'Review'
      ? 'purple'
      : canonical.label === 'Blocked'
        ? 'red'
        : canonical.label === 'Queued' || canonical.label === 'Launching'
          ? 'blue'
          : 'slate';
  return { label: canonical.label, tone };
}

export function sessionPickerTitle(session?: SessionSummary) {
  if (!session) return 'Choose a lane';
  return compactLine(sessionLaneTitle(session), sessionLaneTitle(session), 36);
}

export function sessionHeaderTitle(session?: SessionSummary) {
  if (!session) return 'Choose a lane';
  return compactLine(sessionLaneTitle(session), sessionLaneTitle(session), 42);
}

export function sessionPickerRowSubtitle(session: SessionSummary) {
  if (session.orchestrationPacket) {
    const repoLabel = sessionRepoLabel(session);
    const branchLabel = cleanBranchLabel(session.branch);
    const detail = [repoLabel, branchLabel, sessionRuntimeLabel(session)].filter((value): value is string => Boolean(value));
    return compactLine(detail.join(' \u00b7 '), detail[0] ?? 'Workspace lane', 52);
  }
  const taskSummary = sessionTaskSummary(session, 40);
  const branchLabel = cleanBranchLabel(session.branch);
  if (taskSummary) {
    const combined = branchLabel ? `${taskSummary} \u00b7 ${branchLabel}` : taskSummary;
    return compactLine(combined, taskSummary, 52);
  }
  const parts = [
    sessionTaskLabel(session),
    branchLabel,
  ].filter((value): value is string => Boolean(value));
  if (parts.length > 0) return compactLine(parts.join(' \u00b7 '), parts[0], 52);
  return sessionLocalFolderLabel(session) ?? compactLine(sanitizeTranscriptText(session.currentTask ?? ''), 'Session ready', 52);
}

export function sessionPickerChips(session?: SessionSummary): SessionPickerChip[] {
  if (!session) return [];
  const chips: SessionPickerChip[] = [];
  if (session.orchestrationPacket?.referenceLabel) {
    chips.push({ label: session.orchestrationPacket.referenceLabel, tone: 'blue' });
  }
  chips.push({
    label: sessionRuntimeLabel(session),
    tone: session.runtime === 'claude-code' ? 'purple' : session.runtime === 'codex' ? 'green' : 'slate',
  });
  const state = sessionStateChip(session);
  if (state) chips.push(state);
  return chips;
}

export function buildPickerFallbackSnapshot(sessions: SessionSummary[], selectedKey: string): MobileInboxSnapshot | null {
  if (sessions.length === 0) return null;
  return {
    generatedAt: new Date().toISOString(),
    mode: 'live',
    sourceLabel: 'desktop-session-fallback',
    primarySessionKey: sessions.find((session) => session.sessionKey === selectedKey)?.sessionKey ?? sessions[0]?.sessionKey,
    sessions,
    approvals: [],
    items: [],
    summary: {
      alerts: 0,
      approvals: 0,
      reviewItems: 0,
      activeRuns: sessions.filter((session) => ['running', 'reviewing', 'blocked', 'waiting', 'failed'].includes(session.status)).length,
    },
  };
}

export function composeFooterLeadLabel(session?: SessionSummary, statusOverride?: string) {
  const taskLabel = sessionTaskLabel(session);
  if (taskLabel && /\b(Issue #\d+|PR #\d+)\b/i.test(taskLabel)) return taskLabel;

  const rawStatus = (statusOverride ?? session?.status ?? '').trim().toLowerCase();
  if (rawStatus === 'waiting') return 'Waiting';
  if (rawStatus === 'blocked' || rawStatus === 'failed') return 'Blocked';
  return session ? sessionRuntimeLabel(session) : null;
}

export function compactChatScopeLabel(value?: string | null, max = 30) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/\.git$/i, '')
    .replace(/^~\//, '')
    .replace(/^\/Users\/[^/]+\//, '')
    .replace(/^\/home\/[^/]+\//, '')
    .trim();
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  const label = parts[parts.length - 1] ?? cleaned;
  return compactLine(label, cleaned, max);
}

export function resolveChatScopeLabel(
  selectedSession: SessionSummary | undefined,
  selectedOrchestratorPacket: { title?: string | null; referenceLabel?: string | null } | null | undefined,
  selectedOrchestratorRepoPath: string | null | undefined,
  workspaceLane: { title?: string | null; repoPath?: string | null } | undefined,
) {
  return compactChatScopeLabel(
    workspaceLane?.title?.trim()
      || selectedOrchestratorPacket?.title?.trim()
      || selectedSession?.orchestrationPacket?.title?.trim()
      || selectedSession?.runtimeSurface?.reviewContext?.repoSlug?.trim()
      || selectedOrchestratorRepoPath?.trim()
      || workspaceLane?.repoPath?.trim()
      || selectedSession?.workspace?.trim()
      || selectedSession?.branch?.trim()
      || null,
  );
}

export function buildChatStarterPrompts(
  scopeLabel: string | null,
  taskLabel: string | null,
  repoLabel: string | null,
  noLaneSelected: boolean,
): ChatStarterPrompt[] {
  const focusLabel = taskLabel ?? scopeLabel ?? 'the lane';
  const repoFocusLabel = repoLabel ?? scopeLabel ?? 'the current repo';
  return [
    {
      label: taskLabel ? `Summarize ${taskLabel}` : `Summarize ${focusLabel}`,
      detail: noLaneSelected
        ? 'Prefills the draft for the lane you pick next'
        : `Scoped to ${scopeLabel ?? repoFocusLabel}`,
      text: taskLabel
        ? `Summarize ${taskLabel} and call out the next step.`
        : `Summarize ${focusLabel} and call out the next step.`,
    },
    {
      label: 'Inspect the next file',
      detail: repoLabel ? `Start with ${repoLabel}` : 'Good for first-pass triage',
      text: repoLabel
        ? `Inspect the most relevant file in ${repoLabel} and explain why it matters.`
        : 'Inspect the most relevant file and explain why it matters.',
    },
    {
      label: 'Draft a concise update',
      detail: noLaneSelected
        ? 'Keeps a ready-to-send draft while you choose a lane'
        : 'Useful for status notes and handoffs',
      text: scopeLabel
        ? `Draft a concise update for ${scopeLabel}.`
        : 'Draft a concise update for the current work.',
    },
  ];
}

// ── Text processing ──

export function stripInternalProtocolMarkup(text: string) {
  return INTERNAL_PROTOCOL_TAGS.reduce((next, pattern) => next.replace(pattern, ' '), text);
}

export function collapseInternalTaskPayload(text: string) {
  if (!/<(?:status|summary|task|source|action)>/i.test(text)) return text;

  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.trim();
  const status = text.match(/<status>([\s\S]*?)<\/status>/i)?.[1]?.trim();
  const task = text.match(/<task>([\s\S]*?)<\/task>/i)?.[1]?.trim();

  if (summary) {
    if (status && !summary.toLowerCase().includes(status.toLowerCase())) {
      return `${summary} (${status})`;
    }
    return summary;
  }

  if (task && status) return `${task} (${status})`;
  return text;
}

export function redactSensitiveTranscriptText(text: string) {
  let next = text;
  next = next.replace(/(\bAuthorization\s*:\s*)Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1Bearer [redacted]');
  next = next.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [redacted]');
  next = next.replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token)\b(\s*[:=]\s*)([^\s"'`]+)/gi, '$1[redacted]');
  next = next.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token|auth|authorization|key)=)([^&\s]+)/gi, '$1[redacted]');
  next = next.replace(/\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[0-9A-Za-z\-_]{20,})\b/g, '[redacted]');
  return next;
}

export function sanitizeTranscriptText(text: string) {
  return redactSensitiveTranscriptText(stripInternalProtocolMarkup(collapseInternalTaskPayload(text)));
}

export function stripOperatorMarkdown(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shouldCollapseOperatorEntry(entry: MobileTranscriptEntry) {
  if (entry.role === 'user' || (entry.toolCalls?.length ?? 0) > 0) return false;
  const lineCount = entry.text.split('\n').length;
  const markerHits = OPERATOR_COLLAPSE_MARKERS.filter((pattern) => pattern.test(entry.text)).length;
  return markerHits >= 2 || (markerHits >= 1 && (entry.text.length > 1400 || lineCount > 24));
}

export function buildOperatorSummary(text: string) {
  const lines = text
    .split('\n')
    .map((line) => stripOperatorMarkdown(sanitizeTranscriptText(line)))
    .filter(Boolean)
    .filter((line) => !/^thought for \d/i.test(line))
    .filter((line) => !/^(gemini|opus|claude code|codex)\b/i.test(line))
    .filter((line) => !/^\d{1,2}:\d{2}\s?(am|pm)$/i.test(line));

  const headline = compactLine(lines[0] ?? stripOperatorMarkdown(sanitizeTranscriptText(text)) ?? 'Long assistant note', 'Long assistant note', 180);
  const details = lines
    .slice(1)
    .filter((line) => line !== headline)
    .slice(0, 3)
    .map((line) => compactLine(line, line, 160));

  return {
    headline,
    details,
    stats: `${lines.length || text.split('\n').length} lines \u2022 ${Math.max(1, Math.round(text.length / 100)) / 10}k chars`,
  };
}

export function chipStyles(tone: GroupChipTone): React.CSSProperties {
  if (tone === 'blue') {
    return { background: 'rgba(37, 99, 235, 0.08)', color: '#2563eb' };
  }
  if (tone === 'purple') {
    return { background: 'rgba(139, 92, 246, 0.10)', color: '#7c3aed' };
  }
  if (tone === 'amber') {
    return { background: 'rgba(245, 158, 11, 0.10)', color: '#b45309' };
  }
  if (tone === 'emerald') {
    return { background: 'rgba(16, 185, 129, 0.10)', color: '#047857' };
  }
  return { background: 'rgba(15, 23, 42, 0.06)', color: '#475569' };
}

// ── Sidebar event wrappers ──

export function parseRuntimeEventSummary(text: string): RuntimeEventSummary | null {
  return normalizeSidebarRuntimeEventSummary(text) as RuntimeEventSummary | null;
}

export function groupTimestamp(entries: MobileTranscriptEntry[]): number | undefined {
  return normalizeSidebarGroupTimestamp(entries);
}

export function relativeTimeLabel(timestamp: number): string {
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function summarizeAgentGroup(entries: MobileTranscriptEntry[]): {
  chips: GroupChip[];
  separatorLabel?: string;
  timeLabel?: string;
} {
  return normalizeSidebarAgentGroup(entries);
}

export function looksLikeWorkspaceFile(detail: string): boolean {
  return normalizeSidebarWorkspaceFile(detail);
}

export function buildGroupSourceCards(entries: MobileTranscriptEntry[]): GroupSourceCard[] {
  return normalizeSidebarSourceCards(entries) as GroupSourceCard[];
}

export function groupTranscriptTurns(transcript: MobileTranscriptEntry[]): TranscriptGroup[] {
  return normalizeSidebarTranscriptTurns(transcript) as TranscriptGroup[];
}

export function activityToLiveToolCall(activity?: SessionSummary['activity']): MobileTranscriptToolCall | null {
  return normalizeActivityToSidebarLiveToolCall(activity);
}

export function lastTurnToolCalls(transcript: MobileTranscriptEntry[]): MobileTranscriptToolCall[] {
  return normalizeLastSidebarTurnToolCalls(transcript);
}

export function advanceToolStack(
  previous: MobileTranscriptToolCall[],
  toolName: string,
): MobileTranscriptToolCall[] {
  return normalizeAdvanceSidebarToolStack(previous, toolName);
}

// ── Transcript dedup / merge ──

export function transcriptEntrySignature(entry: MobileTranscriptEntry) {
  return JSON.stringify({
    type: entry.type,
    role: entry.role,
    text: entry.text,
    media: (entry.media ?? []).map((item) => `${item.kind}:${item.path}`),
    toolCalls: (entry.toolCalls ?? []).map((tool) => ({
      name: tool.name,
      args: tool.args,
      status: tool.status,
    })),
    timestamp: entry.timestamp,
    timestampLabel: entry.timestampLabel,
    compaction: entry.compaction,
  });
}

export function dedupeTranscriptEntries(entries: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  if (entries.length < 2) return entries;

  const next: MobileTranscriptEntry[] = [];
  const indexById = new Map<string, number>();
  let changed = false;

  for (const entry of entries) {
    const existingIndex = indexById.get(entry.id);
    if (existingIndex == null) {
      indexById.set(entry.id, next.length);
      next.push(entry);
      continue;
    }
    next[existingIndex] = entry;
    changed = true;
  }

  return changed ? next : entries;
}

export function mergeTranscriptEntries(
  existing: MobileTranscriptEntry[],
  incoming: MobileTranscriptEntry[],
): MobileTranscriptEntry[] {
  if (incoming.length === 0) return existing;

  const next = [...existing];
  const indexById = new Map(next.map((entry, index) => [entry.id, index]));
  let changed = false;

  for (const entry of incoming) {
    const existingIndex = indexById.get(entry.id);
    if (existingIndex == null) {
      indexById.set(entry.id, next.length);
      next.push(entry);
      changed = true;
      continue;
    }

    if (transcriptEntrySignature(next[existingIndex]) === transcriptEntrySignature(entry)) {
      continue;
    }

    next[existingIndex] = entry;
    changed = true;
  }

  return changed ? next : existing;
}

// ── Media helpers ──

export function mediaHref(path: string): string {
  return `/api/mobile/media?path=${encodeURIComponent(path)}`;
}

export function isImageMedia(item: { kind: string }): boolean {
  return item.kind !== 'pdf' && item.kind !== 'file';
}

export function isCompactionEntry(entry: MobileTranscriptEntry): boolean {
  return entry.type === 'compaction'
    || (entry.role === 'system' && entry.text.toLowerCase().includes('compaction'));
}

export function resolveImageSrc(src: string): string {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src;
  return `/api/panel/serve-image?path=${encodeURIComponent(src)}`;
}
