'use client';

/**
 * ThoughtsCard — Floating glass command surface.
 *
 * Orchestrator surface:
 * - Fast agent chat right inside the card
 * - Shared approvals
 * - Context-aware suggestions for intervention and redirection
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { ApprovalRecord } from '@/lib/approvals/types';
import {
  readOrchestratorRuntimePreference,
  subscribeOrchestratorRuntimePreference,
} from '@/lib/orchestrator/preferences';
import {
  orchestratorRuntimeTone,
  orchestratorStatusTone,
} from '@/lib/orchestrator/display';
import { nextPacketReferenceLabel, packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import type {
  OrchestratorLaneBinding,
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';
import { DesktopAgentMessage } from './DesktopAgentMessage';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

// ── Types ──

type PendingApproval = ApprovalRecord;
type ThoughtMode = 'orchestrate' | 'chat';

// ── SVG Icons ──

function GripIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0, opacity: 0.4 }}>
      <circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/>
      <circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
      <circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>
    </svg>
  );
}

function XIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

// ── Main Component ──

interface FleetAgent {
  name?: string;
  status?: string;
  currentTask?: string;
  context?: { usedPercent?: number };
  alerts?: number;
  sessionKey?: string;
  model?: string;
  lastEventAt?: string;
  activity?: { headline?: string };
  runtime?: string;
  isCurrentSession?: boolean;
  workspace?: string;
}

interface ContextSuggestion {
  text: string;
  action: string; // pre-filled message
  agent: AgentTarget;
  priority: 'info' | 'warn' | 'critical';
}

interface ThoughtsCardProps {
  open: boolean;
  onClose: () => void;
  agents?: FleetAgent[];
  draftInjection?: { id: string; text: string } | null;
  docked?: boolean;
  missionState: OrchestratorMissionState;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  onMissionStateChange: (
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState)
  ) => void;
  onLaunchPacket?: (packet: OrchestratorPacket) => Promise<OrchestratorLaneBinding | null> | OrchestratorLaneBinding | null;
  onFocusPacket?: (packet: OrchestratorPacket) => void;
}

interface AgentTarget {
  key: string;
  name: string;
  runtime: OrchestratorRuntime;
  color: string;
  workspace?: string | null;
  isCurrentSession?: boolean;
}

function normalizeMissionText(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeMissionPrompt(value: string) {
  const normalized = normalizeMissionText(value);
  if (!normalized) return '';
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177).trimEnd()}...`;
}

function packetDependencyInput(labels: string[]) {
  return labels.join(', ');
}

function parseDependencyInput(value: string) {
  return value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function createPacketId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pkt-${crypto.randomUUID()}`;
  }
  return `pkt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createDraftPacket(
  runtime: OrchestratorRuntime,
  workspaceTargets: OrchestratorWorkspaceTarget[],
  existingPackets: Array<Pick<OrchestratorPacket, 'referenceLabel'>>,
  seed?: Partial<OrchestratorPacket>,
): OrchestratorPacket {
  const target = seed?.workspaceTargetPath
    ? workspaceTargets.find((entry) => entry.localPath === seed.workspaceTargetPath) ?? null
    : workspaceTargets[0] ?? null;
  return {
    id: seed?.id ?? createPacketId(),
    referenceLabel: seed?.referenceLabel ?? nextPacketReferenceLabel(existingPackets),
    title: seed?.title ?? 'New work packet',
    summary: seed?.summary ?? '',
    workspaceTargetPath: seed?.workspaceTargetPath ?? target?.localPath ?? null,
    branchTarget: seed?.branchTarget ?? target?.branch ?? 'main',
    runtime: seed?.runtime ?? runtime,
    dependencyLabels: seed?.dependencyLabels ?? [],
    dependencyPacketIds: seed?.dependencyPacketIds ?? [],
    queueState: seed?.queueState ?? 'draft',
    releaseState: seed?.releaseState ?? 'pending',
    status: seed?.status ?? 'draft',
    blockedReason: seed?.blockedReason ?? null,
    lastEventAt: seed?.lastEventAt ?? null,
    lastEventLabel: seed?.lastEventLabel ?? null,
    lane: seed?.lane ?? null,
  };
}

function packetTitleFromPrompt(value: string) {
  const normalized = normalizeMissionText(value);
  if (!normalized) return 'New work packet';
  const compact = normalized.replace(/[.?!]+$/g, '');
  if (compact.length <= 54) return compact;
  return `${compact.slice(0, 51).trimEnd()}...`;
}

function pickWorkspaceTargetForText(
  text: string,
  workspaceTargets: OrchestratorWorkspaceTarget[],
) {
  const normalized = text.toLowerCase();
  return workspaceTargets.find((target) => {
    const repoName = target.repoName.toLowerCase();
    const label = target.label.toLowerCase();
    return normalized.includes(repoName) || normalized.includes(label);
  }) ?? workspaceTargets[0] ?? null;
}

function buildPacketsFromMissionPrompt(
  prompt: string,
  workspaceTargets: OrchestratorWorkspaceTarget[],
  runtime: OrchestratorRuntime,
) {
  const clauses = prompt
    .split(/\n|;|(?:\s+and then\s+)|(?:\s+then\s+)/i)
    .map((part) => normalizeMissionText(part))
    .filter(Boolean)
    .slice(0, 5);
  const seeds = clauses.length > 0 ? clauses : [normalizeMissionText(prompt)].filter(Boolean);
  return seeds.map((seed, index) => {
    const target = pickWorkspaceTargetForText(seed, workspaceTargets);
    return createDraftPacket(runtime, workspaceTargets, Array.from({ length: index }).map((_, itemIndex) => ({
      referenceLabel: `P${itemIndex + 1}`,
    })), {
      title: packetTitleFromPrompt(seed),
      summary: seed,
      workspaceTargetPath: target?.localPath ?? null,
      branchTarget: target?.branch ?? (index === 0 ? 'main' : `packet-${index + 1}`),
      dependencyLabels: index === 0 ? [] : [`P${index}`],
      dependencyPacketIds: [],
      queueState: 'draft',
      releaseState: 'pending',
    });
  });
}

function isRunnableCliSession(agent: FleetAgent) {
  const runtime = agent.runtime;
  const sessionKey = agent.sessionKey?.trim();
  if (!sessionKey) return false;
  if (runtime !== 'codex' && runtime !== 'claude-code') return false;
  if (sessionKey.includes(':ide-tab-')) return false;
  return true;
}

function buildAgentTargets(
  agents: FleetAgent[],
  preferredRuntime: OrchestratorRuntime,
) {
  const cliAgents = agents
    .filter(isRunnableCliSession)
    .sort((left, right) => {
      const runtimeScore = (runtime?: string) => (runtime === preferredRuntime ? 2 : 1);
      const currentScore = (agent: FleetAgent) => (agent.isCurrentSession ? 2 : 0);
      const statusScore = (status?: string) => (status === 'running' ? 2 : status === 'reviewing' ? 1 : 0);
      const delta = runtimeScore(right.runtime) + currentScore(right) + statusScore(right.status)
        - runtimeScore(left.runtime) - currentScore(left) - statusScore(left.status);
      if (delta !== 0) return delta;
      return (right.lastEventAt ?? '').localeCompare(left.lastEventAt ?? '');
    });

  return cliAgents.map((agent) => {
    const runtime = agent.runtime === 'claude-code' ? 'claude-code' : 'codex';
    const runtimeTone = orchestratorRuntimeTone(runtime);
    return {
      key: agent.sessionKey!,
      name: agent.name?.trim() || runtimeTone.label,
      runtime,
      color: runtimeTone.color,
      workspace: agent.workspace?.trim() || null,
      isCurrentSession: Boolean(agent.isCurrentSession),
    } satisfies AgentTarget;
  });
}

function entrySignature(entry: MobileTranscriptEntry) {
  return JSON.stringify({
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
  });
}

function isRenderableThoughtEntry(entry: MobileTranscriptEntry) {
  return Boolean(
    entry.text.trim()
    || entry.media?.length
    || entry.toolCalls?.length,
  );
}

function mergeTranscriptEntries(
  existing: MobileTranscriptEntry[],
  incoming: MobileTranscriptEntry[],
) {
  if (incoming.length === 0) return existing;

  const next = [...existing];
  const indexById = new Map(next.map((entry, index) => [entry.id, index]));

  for (const entry of incoming) {
    const existingIndex = indexById.get(entry.id);
    if (existingIndex == null) {
      indexById.set(entry.id, next.length);
      next.push(entry);
      continue;
    }
    next[existingIndex] = entry;
  }

  return next;
}

function generateSuggestions(agents: FleetAgent[], targets: AgentTarget[]): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = [];
  const targetBySessionKey = new Map(targets.map((target) => [target.key, target]));
  const targetByName = new Map(targets.map((target) => [target.name.toLowerCase(), target]));
  const targetByRuntime = new Map<OrchestratorRuntime, AgentTarget>();
  targets.forEach((target) => {
    if (!targetByRuntime.has(target.runtime)) {
      targetByRuntime.set(target.runtime, target);
    }
  });

  for (const agent of agents) {
    const name = agent.name || 'Unknown';
    const runtime = agent.runtime === 'claude-code' ? 'claude-code' : 'codex';
    const target = (agent.sessionKey ? targetBySessionKey.get(agent.sessionKey) : null)
      ?? targetByName.get(name.toLowerCase())
      ?? targetByRuntime.get(runtime)
      ?? targets[0];
    if (!target) continue;

    // Context pressure warning
    const ctx = agent.context?.usedPercent ?? 0;
    if (ctx > 80) {
      suggestions.push({
        text: `${name} is at ${Math.round(ctx)}% context — approaching limit`,
        action: `What's your context status? Do you need to compact?`,
        agent: target,
        priority: ctx > 90 ? 'critical' : 'warn',
      });
    }

    // Agent stuck / failed
    if (agent.status === 'failed' || agent.status === 'error') {
      suggestions.push({
        text: `${name} has failed — may need intervention`,
        action: `What happened? Can you recover?`,
        agent: target,
        priority: 'critical',
      });
    }

    // Agent idle for a while with a task
    if (agent.status === 'idle' && agent.currentTask) {
      const lastEvent = agent.lastEventAt ? new Date(agent.lastEventAt).getTime() : 0;
      const idleMinutes = lastEvent ? (Date.now() - lastEvent) / 60000 : 0;
      if (idleMinutes > 30) {
        suggestions.push({
          text: `${name} has been idle ${Math.round(idleMinutes)}min with task: "${agent.currentTask}"`,
          action: `Status update on "${agent.currentTask}"?`,
          agent: target,
          priority: 'warn',
        });
      }
    }

    // Alerts
    if (agent.alerts && agent.alerts > 0) {
      suggestions.push({
        text: `${name} has ${agent.alerts} alert${agent.alerts > 1 ? 's' : ''}`,
        action: `What alerts do you have? Anything I should know?`,
        agent: target,
        priority: 'warn',
      });
    }
  }

  // Sort: critical first, then warn, then info
  const priorityOrder = { critical: 0, warn: 1, info: 2 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return suggestions.slice(0, 3); // max 3 suggestions
}

export function ThoughtsCard({
  open,
  onClose,
  agents = [],
  draftInjection,
  docked = false,
  missionState,
  workspaceTargets = [],
  onMissionStateChange,
  onLaunchPacket,
  onFocusPacket,
}: ThoughtsCardProps) {
  const [mode, setMode] = useState<ThoughtMode>('orchestrate');
  const [input, setInput] = useState('');
  const [preEnhanceInput, setPreEnhanceInput] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [preferredRuntime, setPreferredRuntime] = useState<OrchestratorRuntime>(() => readOrchestratorRuntimePreference());
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 460, h: 0 });
  const [initialized, setInitialized] = useState(false);

  // Task chat state
  const [chatMessages, setChatMessages] = useState<MobileTranscriptEntry[]>([]);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const pollRef = useRef<number | null>(null);
  const pollDelayRef = useRef<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const seenServerEntriesRef = useRef<Map<string, string>>(new Map());
  const responseSeenRef = useRef(false);
  const idlePollsRef = useRef(0);

  // Approval state
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const approvalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number; corner: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const missionPromptRef = useRef<HTMLTextAreaElement>(null);

  const sessionTargets = useMemo(
    () => buildAgentTargets(agents, preferredRuntime),
    [agents, preferredRuntime],
  );
  const [targetAgentKey, setTargetAgentKey] = useState<string>('');
  const targetAgent = useMemo(
    () => sessionTargets.find((agent) => agent.key === targetAgentKey) ?? sessionTargets[0] ?? null,
    [sessionTargets, targetAgentKey],
  );
  const targetSessionKey = targetAgent?.key ?? null;

  useEffect(() => subscribeOrchestratorRuntimePreference(setPreferredRuntime), []);

  useEffect(() => {
    if (!targetAgent && sessionTargets.length > 0) {
      setTargetAgentKey(sessionTargets[0].key);
      return;
    }
    if (targetAgent && sessionTargets.every((agent) => agent.key !== targetAgent.key)) {
      setTargetAgentKey(sessionTargets[0]?.key ?? '');
    }
  }, [sessionTargets, targetAgent]);

  // ── Repo issues for Mission Control ──

  type RepoIssue = { number: number; title: string; url?: string; labels?: string[] };
  const [repoIssues, setRepoIssues] = useState<RepoIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false); // eslint-disable-line @typescript-eslint/no-unused-vars -- reserved for loading indicator
  const [issuesCollapsed, setIssuesCollapsed] = useState(false);
  const [issuesShowAll, setIssuesShowAll] = useState(false);
  const [expandedPacketId, setExpandedPacketId] = useState<string | null>(null);
  const issuesRepoSlugRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open || mode !== 'orchestrate' || workspaceTargets.length === 0) return;

    let cancelled = false;
    (async () => {
      // Resolve repo slug from the repos API (has remoteUrl)
      try {
        const reposRes = await fetch('/api/panel/repos');
        if (!reposRes.ok || cancelled) return;
        const reposData = await reposRes.json() as { repos?: Array<{ localPath: string; remoteUrl?: string }> };
        const targetPath = workspaceTargets[0]?.localPath;
        const matched = (reposData.repos ?? []).find((r) => r.localPath === targetPath);
        if (!matched?.remoteUrl || cancelled) return;

        const slug = matched.remoteUrl.replace(/\.git$/, '').split('/').slice(-2).join('/');
        if (!slug || slug === issuesRepoSlugRef.current) return;
        issuesRepoSlugRef.current = slug;

        setIssuesLoading(true);
        const issuesRes = await fetch(`/api/panel/issues?repo=${encodeURIComponent(slug)}`);
        if (!issuesRes.ok || cancelled) { setIssuesLoading(false); return; }
        const issuesData = await issuesRes.json() as { issues?: Array<{ number: number; title: string; state: string; url?: string; labels?: Array<{ name: string } | string> }> };
        const openIssues = (issuesData.issues ?? [])
          .filter((i) => i.state === 'open')
          .slice(0, 12)
          .map((i) => ({
            number: i.number,
            title: i.title,
            url: i.url,
            labels: (i.labels ?? []).map((l) => typeof l === 'string' ? l : l.name),
          }));
        if (!cancelled) setRepoIssues(openIssues);
      } catch { /* silent */ }
      if (!cancelled) setIssuesLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, mode, workspaceTargets]);

  // Center on first open
  useEffect(() => {
    if (docked) return;
    if (open && !initialized) {
      setPosition({
        x: Math.max(100, Math.round(window.innerWidth / 2 - 200)),
        y: Math.max(80, Math.round(window.innerHeight / 2 - 200)),
      });
      setInitialized(true);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [docked, open, initialized]);

  // Focus input whenever the surface becomes active again
  useEffect(() => {
    if (open && !minimized) {
      const nextFocus = mode === 'orchestrate'
        ? missionPromptRef.current
        : inputRef.current;
      setTimeout(() => nextFocus?.focus(), 50);
    }
  }, [mode, open, minimized]);

  useEffect(() => {
    if (!open || docked) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [docked, onClose, open]);

  useEffect(() => {
    if (!open || !draftInjection?.id) return;
    setMode('chat');
    setMinimized(false);
    setInput((prev) => prev.trim()
      ? `${prev.trimEnd()}\n\n${draftInjection.text}\n\n`
      : `${draftInjection.text}\n\n`);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [draftInjection?.id, draftInjection?.text, open]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Auto-expand the floating card when it opens
  useEffect(() => {
    if (open && !docked && size.h === 0) {
      setSize(prev => ({ ...prev, h: 420 }));
    }
  }, [docked, open, size.h]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      if (pollDelayRef.current !== null) window.clearTimeout(pollDelayRef.current);
    };
  }, []);

  // ── Approval polling — runs whenever card is open ──
  useEffect(() => {
    if (!open) return;

    const pollApprovals = async () => {
      try {
        const res = await fetch('/api/panel/approvals');
        if (res.ok) {
          const data = await res.json();
          setApprovals(data.approvals || []);
        }
      } catch { /* silent */ }
    };

    pollApprovals(); // immediate
    // Poll fast only when likely to have approvals (agent running), otherwise slow
    approvalPollRef.current = setInterval(pollApprovals, 15_000);

    return () => {
      if (approvalPollRef.current) clearInterval(approvalPollRef.current);
    };
  }, [open]);

  // ── Approval handlers ──
  const handleApprovalResolve = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setResolvingId(id);
    try {
      const res = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
      if (res.ok) {
        setApprovals(prev => prev.filter(a => a.id !== id));
      }
    } catch { /* silent */ }
    setResolvingId(null);
  }, []);

  // ── Drag handlers ──

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: position.x, origY: position.y };

    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - 200, dragRef.current.origX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 100, dragRef.current.origY + dy)),
      });
    };
    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [position]);

  // ── Resize handlers ──

  const handleResizeStart = useCallback((corner: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const currentH = cardRef.current?.getBoundingClientRect().height || 300;
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: currentH, corner };

    const handleMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const dx = ev.clientX - resizeRef.current.startX;
      const dy = ev.clientY - resizeRef.current.startY;
      const c = resizeRef.current.corner;

      let newW = resizeRef.current.origW;
      let newH = resizeRef.current.origH;

      if (c.includes('e')) newW = Math.max(320, Math.min(800, resizeRef.current.origW + dx));
      if (c.includes('w')) {
        newW = Math.max(320, Math.min(800, resizeRef.current.origW - dx));
        setPosition(p => ({ ...p, x: Math.max(0, p.x + dx) }));
      }
      if (c.includes('s')) newH = Math.max(200, Math.min(700, resizeRef.current.origH + dy));

      setSize({ w: newW, h: newH });
    };

    const handleUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [size.w]);

  // ── Poll for agent response ──

  const clearPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollDelayRef.current !== null) {
      window.clearTimeout(pollDelayRef.current);
      pollDelayRef.current = null;
    }
  }, []);

  const captureServerSnapshot = useCallback(async (sessionKey: string) => {
    try {
      const res = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=16&fresh=1`);
      if (!res.ok) return;
      const data = await res.json();
      const entries = (data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[];
      const nextSeen = new Map<string, string>();
      for (const entry of entries) {
        nextSeen.set(entry.id, entrySignature(entry));
      }
      seenServerEntriesRef.current = nextSeen;
    } catch {
      // silent
    }
  }, []);

  const startPolling = useCallback(() => {
    const sessionKey = targetSessionKey;
    if (!sessionKey) {
      setWaitingForReply(false);
      return;
    }
    clearPolling();
    responseSeenRef.current = false;
    idlePollsRef.current = 0;

    let attempts = 0;
    const maxAttempts = 45;

    const poll = async () => {
      attempts++;
      if (attempts > maxAttempts) {
        clearPolling();
        setWaitingForReply(false);
        return;
      }

      try {
        const res = await fetch(
          `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=20&fresh=1`,
        );
        if (!res.ok) return;

        const data = await res.json();
        const entries = (data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[];
        const nextSeen = new Map(seenServerEntriesRef.current);
        const incoming: MobileTranscriptEntry[] = [];

        for (const entry of entries) {
          const signature = entrySignature(entry);
          const previousSignature = nextSeen.get(entry.id);
          nextSeen.set(entry.id, signature);

          if (previousSignature === signature) continue;
          if (entry.role === 'user') continue;
          if (!isRenderableThoughtEntry(entry)) continue;
          incoming.push(entry);
        }

        seenServerEntriesRef.current = nextSeen;

        if (incoming.length > 0) {
          responseSeenRef.current = true;
          idlePollsRef.current = 0;
          setChatMessages((prev) => mergeTranscriptEntries(prev, incoming));
          return;
        }

        if (responseSeenRef.current) {
          idlePollsRef.current += 1;
          if (idlePollsRef.current >= 2) {
            clearPolling();
            setWaitingForReply(false);
          }
        }
      } catch {
        // silent retry
      }
    };

    pollDelayRef.current = window.setTimeout(() => {
      void poll();
      pollRef.current = window.setInterval(() => {
        void poll();
      }, 2200);
    }, 900);
  }, [clearPolling, targetSessionKey]);

  // ── Orchestrator chat: send message ──

  const handleTaskSend = useCallback(async () => {
    const sessionKey = targetSessionKey;
    if (!input.trim() || waitingForReply || !sessionKey) return;
    const msg = input.trim();
    setInput('');

    // Add user message to chat
    const userMsg: MobileTranscriptEntry = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      text: msg,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setChatMessages(prev => [...prev, userMsg]);
    setWaitingForReply(true);

    try {
      await captureServerSnapshot(sessionKey);

      const response = await fetch('/api/mobile/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'resume',
          sessionKey,
          message: msg,
        }),
      });

      if (!response.ok) {
        throw new Error('Send failed');
      }

      startPolling();
    } catch {
      setChatMessages(prev => [
        ...prev,
        {
          id: `local-error-${Date.now()}`,
          role: 'system',
          text: 'Unable to reach the selected CLI lane. Make sure the Codex or Claude Code session is available.',
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      setWaitingForReply(false);
    }
  }, [captureServerSnapshot, input, startPolling, targetSessionKey, waitingForReply]);

  const handleReset = useCallback(() => {
    setInput('');
    setPreEnhanceInput(null);
    setChatMessages([]);
    setWaitingForReply(false);
    setAgentPickerOpen(false);
    clearPolling();
    seenServerEntriesRef.current.clear();
    responseSeenRef.current = false;
    idlePollsRef.current = 0;
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [clearPolling]);

  const handleEnhance = useCallback(async () => {
    if (!input.trim() || enhancing) return;
    setEnhancing(true);
    setPreEnhanceInput(input);
    try {
      const res = await fetch('/api/mobile/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: input }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.enhanced) setInput(data.enhanced);
      }
    } catch {
      // silently fail
    } finally {
      setEnhancing(false);
    }
  }, [input, enhancing]);

  const handleUndoEnhance = useCallback(() => {
    if (preEnhanceInput !== null) {
      setInput(preEnhanceInput);
      setPreEnhanceInput(null);
    }
  }, [preEnhanceInput]);

  const suggestions = useMemo(
    () => generateSuggestions(agents.filter(isRunnableCliSession), sessionTargets),
    [agents, sessionTargets],
  );
  const targetAgentState = useMemo(
    () => targetAgent
      ? agents.find((agent) => agent.sessionKey === targetAgent.key || agent.name?.toLowerCase() === targetAgent.name.toLowerCase())
      : null,
    [agents, targetAgent],
  );
  const targetAgentModel = targetAgentState?.model
    ?? (targetAgent ? orchestratorRuntimeTone(targetAgent.runtime).label : orchestratorRuntimeTone(preferredRuntime).label);
  const targetAgentContext = targetAgentState?.context?.usedPercent;
  const targetAgentTask = targetAgentState?.activity?.headline ?? targetAgentState?.currentTask;
  const hasAssistantActivity = chatMessages.some((message) => message.role !== 'user');
  const activeTargetLabel = targetAgent?.name ?? orchestratorRuntimeTone(preferredRuntime).label;
  const activeTargetColor = targetAgent?.color ?? orchestratorRuntimeTone(preferredRuntime).color;
  const activeTargetRuntimeLabel = targetAgent ? orchestratorRuntimeTone(targetAgent.runtime).label : orchestratorRuntimeTone(preferredRuntime).label;
  const thoughtsBodyBackground = 'linear-gradient(180deg, var(--t-glass-muted) 0%, rgba(0, 0, 0, 0) 100%)';
  const thoughtsElevatedSurface = 'var(--t-glass-elevated)';
  const thoughtsElevatedBorder = '1px solid var(--t-glass-border-strong)';
  const thoughtsElevatedShadow = 'var(--t-glass-shadow)';
  const thoughtsMutedGlass = 'var(--t-glass-muted-strong)';

  const updateMissionState = useCallback((
    updater: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState),
  ) => {
    onMissionStateChange(updater);
  }, [onMissionStateChange]);

  const handleMissionPromptChange = useCallback((value: string) => {
    updateMissionState((current) => ({
      ...current,
      prompt: value,
    }));
  }, [updateMissionState]);

  const handlePlanMission = useCallback(() => {
    const normalizedPrompt = missionState.prompt.trim();
    if (!normalizedPrompt) return;
    const plannedPackets = buildPacketsFromMissionPrompt(normalizedPrompt, workspaceTargets, preferredRuntime);
    updateMissionState((current) => ({
      ...current,
      prompt: missionState.prompt,
      summary: summarizeMissionPrompt(normalizedPrompt),
      packets: plannedPackets.length > 0
        ? plannedPackets
        : [createDraftPacket(preferredRuntime, workspaceTargets, [], {
            title: packetTitleFromPrompt(normalizedPrompt),
            summary: normalizedPrompt,
          })],
    }));
  }, [missionState.prompt, preferredRuntime, updateMissionState, workspaceTargets]);

  const handleAddPacket = useCallback(() => {
    updateMissionState((current) => ({
      ...current,
      packets: [
        ...current.packets,
        createDraftPacket(preferredRuntime, workspaceTargets, current.packets),
      ],
    }));
  }, [preferredRuntime, updateMissionState, workspaceTargets]);

  const handleCreatePacketFromIssue = useCallback((issue: { number: number; title: string }) => {
    const target = workspaceTargets[0] ?? null;
    updateMissionState((current) => ({
      ...current,
      packets: [
        ...current.packets,
        createDraftPacket(preferredRuntime, workspaceTargets, current.packets, {
          title: issue.title,
          summary: `#${issue.number} — ${issue.title}`,
          workspaceTargetPath: target?.localPath ?? null,
          branchTarget: target?.branch ?? 'main',
          queueState: 'draft',
        }),
      ],
    }));
  }, [preferredRuntime, updateMissionState, workspaceTargets]);

  const handleRemovePacketForIssue = useCallback((issueNumber: number) => {
    updateMissionState((current) => ({
      ...current,
      packets: current.packets.filter((p) => !p.summary.includes(`#${issueNumber}`)),
    }));
  }, [updateMissionState]);

  const handleLinkIssueToPacket = useCallback((issue: { number: number; title: string }) => {
    // Link this issue into the currently expanded packet, or the last packet if none expanded
    const targetId = expandedPacketId ?? missionState.packets[missionState.packets.length - 1]?.id;
    if (!targetId) return;
    updateMissionState((current) => ({
      ...current,
      packets: current.packets.map((p) => {
        if (p.id !== targetId) return p;
        const ref = `#${issue.number}`;
        if (p.summary.includes(ref)) return p;
        const nextSummary = p.summary ? `${p.summary}\n${ref} — ${issue.title}` : `${ref} — ${issue.title}`;
        return { ...p, summary: nextSummary };
      }),
    }));
  }, [expandedPacketId, missionState.packets, updateMissionState]);

  const patchPacket = useCallback((packetId: string, updater: (packet: OrchestratorPacket) => OrchestratorPacket) => {
    updateMissionState((current) => ({
      ...current,
      packets: current.packets.map((packet) => (packet.id === packetId ? updater(packet) : packet)),
    }));
  }, [updateMissionState]);

  const handleLaunchPacket = useCallback(async (packet: OrchestratorPacket) => {
    try {
      const binding = await onLaunchPacket?.(packet);
      patchPacket(packet.id, (current) => ({
        ...current,
        queueState: 'queued',
        status: binding ? 'idle' : current.status,
        blockedReason: null,
        lane: binding ?? current.lane ?? null,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to launch this packet.';
      console.error(error);
      patchPacket(packet.id, (current) => ({
        ...current,
        blockedReason: message,
      }));
    }
  }, [onLaunchPacket, patchPacket]);

  const handleFocusPacket = useCallback((packet: OrchestratorPacket) => {
    onFocusPacket?.(packet);
  }, [onFocusPacket]);

  if (!open && !docked) return null;

  // ── Render ──

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
        @keyframes llmFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes llmDot {
          0%, 80%, 100% { transform: scale(0.7); opacity: 0.45; }
          40% { transform: scale(1); opacity: 1; }
        }
        @keyframes compactionProgress {
          0% { width: 10%; }
          50% { width: 70%; }
          100% { width: 95%; }
        }
      `}</style>

      <div
        ref={cardRef}
        style={{
          position: docked ? 'relative' : 'fixed',
          left: docked ? undefined : position.x,
          top: docked ? undefined : position.y,
          width: docked ? '100%' : (minimized ? 220 : size.w),
          height: docked ? '100%' : (minimized ? 'auto' : (size.h > 0 ? size.h : 'auto')),
          zIndex: docked ? 1 : 10001,
          borderRadius: docked ? 14 : (minimized ? 12 : 18),
          background: 'var(--t-panel-translucent)',
          backdropFilter: 'blur(50px) saturate(180%)',
          WebkitBackdropFilter: 'blur(50px) saturate(180%)',
          border: '1px solid var(--t-panel-border)',
          boxShadow: docked ? 'none' : 'var(--t-panel-shadow)',
          overflow: docked ? 'hidden' : 'visible',
          display: 'flex',
          flexDirection: 'column',
          flex: docked ? 1 : undefined,
          minHeight: 0,
          transition: 'border-radius 250ms',
          fontFamily: '-apple-system, system-ui, BlinkMacSystemFont, sans-serif',
        }}
      >
        {/* ── Header — drag handle ── */}
        <div
          onMouseDown={docked ? undefined : handleDragStart}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: minimized ? '8px 12px' : '10px 14px',
            cursor: docked ? 'default' : 'grab',
            userSelect: 'none',
            borderBottom: minimized ? 'none' : '1px solid var(--t-divider-subtle)',
            flexShrink: 0,
          }}
        >
          {!docked && <GripIcon />}
          <span style={{
            fontSize: 12, fontWeight: 700, color: 'var(--t-text)',
            letterSpacing: '-0.01em', flex: 1,
          }}>
            {mode === 'chat' && chatMessages.length > 0 ? activeTargetLabel : 'Thoughts'}
          </span>
          {/* Approval count badge */}
          {approvals.length > 0 && (
            <span style={{
              minWidth: 18, height: 18, borderRadius: 9,
              background: '#ef4444', color: '#fff',
              fontSize: 10, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '0 5px', letterSpacing: 0,
              animation: 'pulse 2s ease-in-out infinite',
            }}>
              {approvals.length}
            </span>
          )}
          {mode === 'chat' && waitingForReply && !minimized && (
            <span style={{
              fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
              padding: '2px 7px', borderRadius: 5,
              background: 'rgba(37,99,235,0.1)',
              color: '#2563eb',
              letterSpacing: '0.03em',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>
              Thinking...
            </span>
          )}
          {/* Reset active thread */}
          {mode === 'chat' && chatMessages.length > 0 && !minimized && (
            <button type="button" onClick={handleReset} title="Clear thread" style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 4,
              color: 'var(--t-text-muted)', display: 'flex', borderRadius: 6, fontSize: 11, fontWeight: 600,
            }}>
              Reset
            </button>
          )}
          {!docked && (
            <>
              <button type="button" onClick={() => setMinimized(v => !v)} style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                color: 'var(--t-text-muted)', display: 'flex', borderRadius: 6,
              }}>
                <MinimizeIcon />
              </button>
              <button type="button" onClick={onClose} style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                color: 'var(--t-text-muted)', display: 'flex', borderRadius: 6,
              }}>
                <XIcon />
              </button>
            </>
          )}
        </div>

        {/* ── Body ── */}
	        {!minimized && (
	          <div style={{
	            flex: 1,
	            display: 'flex',
	            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: docked ? '0 0 14px 14px' : '0 0 18px 18px',
          }}>

            {/* ── APPROVAL CARDS — float above everything ── */}
            {approvals.length > 0 && (
              <div style={{
                padding: '8px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                borderBottom: '1px solid var(--t-divider)',
                flexShrink: 0,
                maxHeight: 200,
                overflowY: 'auto',
              }}>
                {approvals.map((approval) => (
                  <div key={approval.id} style={{
                    padding: '10px 12px',
                    borderRadius: 14,
                    background: approval.risk === 'high'
                      ? 'rgba(239, 68, 68, 0.06)'
                      : approval.risk === 'medium'
                      ? 'rgba(245, 158, 11, 0.06)'
                      : 'rgba(37, 99, 235, 0.06)',
                    border: `1px solid ${
                      approval.risk === 'high'
                        ? 'rgba(239, 68, 68, 0.15)'
                        : approval.risk === 'medium'
                        ? 'rgba(245, 158, 11, 0.15)'
                        : 'rgba(37, 99, 235, 0.12)'
                    }`,
                  }}>
                    {/* Header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={
                        approval.risk === 'high' ? '#ef4444' : approval.risk === 'medium' ? '#f59e0b' : '#2563eb'
                      } strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                      </svg>
                      <span style={{
                        fontSize: 11, fontWeight: 700, color: 'var(--t-text)',
                        letterSpacing: '-0.01em', flex: 1,
                      }}>
                        {approval.agent} — {approval.title}
                      </span>
                      <span style={{
                        fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                        padding: '2px 6px', borderRadius: 5,
                        background: approval.risk === 'high'
                          ? 'rgba(239, 68, 68, 0.1)'
                          : approval.risk === 'medium'
                          ? 'rgba(245, 158, 11, 0.1)'
                          : 'rgba(37, 99, 235, 0.1)',
                        color: approval.risk === 'high'
                          ? '#ef4444'
                          : approval.risk === 'medium'
                          ? '#f59e0b'
                          : '#2563eb',
                        letterSpacing: '0.03em',
                      }}>
                        {approval.risk}
                      </span>
                    </div>

                    {/* Description */}
                    <div style={{
                      fontSize: 11, color: 'var(--t-text-secondary)', lineHeight: 1.5,
                      marginBottom: approval.command ? 6 : 8,
                    }}>
                      {approval.description}
                    </div>

                    {/* Command preview */}
                    {approval.command && (
                      <div style={{
                        padding: '6px 8px', borderRadius: 8,
                        background: 'var(--t-code-bg)',
                        fontFamily: 'SF Mono, Menlo, monospace',
                        fontSize: 10, color: 'var(--t-text)',
                        marginBottom: 8, whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all', lineHeight: 1.4,
                      }}>
                        $ {approval.command}
                      </div>
                    )}

                    {/* Action buttons */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => handleApprovalResolve(approval.id, 'approve')}
                        disabled={resolvingId === approval.id}
                        style={{
                          flex: 1, padding: '7px 0', borderRadius: 10, border: 'none',
                          background: '#22c55e', color: '#fff',
                          fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          opacity: resolvingId === approval.id ? 0.5 : 1,
                          letterSpacing: '-0.01em',
                        }}
                      >
                        {resolvingId === approval.id ? 'Resolving...' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApprovalResolve(approval.id, 'reject')}
                        disabled={resolvingId === approval.id}
                        style={{
                          flex: 1, padding: '7px 0', borderRadius: 10,
                          border: '1px solid rgba(239, 68, 68, 0.2)',
                          background: 'rgba(239, 68, 68, 0.06)',
                          color: '#ef4444',
                          fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          opacity: resolvingId === approval.id ? 0.5 : 1,
                          letterSpacing: '-0.01em',
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
	              </div>
	            )}

	            <div style={{
	              display: 'flex',
	              gap: 8,
	              padding: '10px 12px 0',
	              flexShrink: 0,
	            }}>
	              {([
	                { key: 'orchestrate' as const, label: 'Mission Control' },
	                { key: 'chat' as const, label: 'Live Chat' },
	              ]).map((option) => (
	                <button
	                  key={option.key}
	                  type="button"
	                  onClick={() => setMode(option.key)}
	                  style={{
	                    border: mode === option.key ? '1px solid var(--t-accent-border)' : '1px solid var(--t-panel-border)',
	                    background: mode === option.key ? 'var(--t-accent-soft)' : 'var(--t-panel)',
	                    color: mode === option.key ? 'var(--t-text)' : 'var(--t-text-secondary)',
	                    padding: '6px 10px',
	                    borderRadius: 999,
	                    fontSize: 11,
	                    fontWeight: 700,
	                    cursor: 'pointer',
	                    transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
	                  }}
	                >
	                  {option.label}
	                </button>
	              ))}
	            </div>

	            {mode === 'orchestrate' ? (
	              <div style={{
	                flex: 1,
	                overflowY: 'auto',
	                padding: '12px',
	                display: 'flex',
	                flexDirection: 'column',
	                gap: 12,
	                background: thoughtsBodyBackground,
	              }}>
	                <div style={{
	                  padding: '16px 18px',
	                  borderRadius: 18,
	                  background: thoughtsElevatedSurface,
	                  border: thoughtsElevatedBorder,
	                  boxShadow: thoughtsElevatedShadow,
	                  display: 'flex',
	                  flexDirection: 'column',
	                  gap: 12,
	                }}>
	                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, justifyContent: 'space-between' }}>
	                    <div>
	                      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
	                        Mission Control
	                      </div>
	                      <div style={{ marginTop: 4, fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5, maxWidth: 420 }}>
	                        Thoughts owns planning and routing. Workspace tabs and worktrees stay visible as the execution lanes.
	                      </div>
	                    </div>
	                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
	                      <span style={{
	                        display: 'inline-flex',
	                        alignItems: 'center',
	                        gap: 6,
	                        padding: '5px 9px',
	                        borderRadius: 999,
	                        background: thoughtsMutedGlass,
	                        border: thoughtsElevatedBorder,
	                        fontSize: 10,
	                        fontWeight: 700,
	                        color: 'var(--t-text-secondary)',
	                      }}>
	                        Default runtime
	                        <span style={{ color: orchestratorRuntimeTone(preferredRuntime).color }}>
	                          {orchestratorRuntimeTone(preferredRuntime).label}
	                        </span>
	                      </span>
	                      <span style={{
	                        display: 'inline-flex',
	                        alignItems: 'center',
	                        gap: 6,
	                        padding: '5px 9px',
	                        borderRadius: 999,
	                        background: thoughtsMutedGlass,
	                        border: thoughtsElevatedBorder,
	                        fontSize: 10,
	                        fontWeight: 700,
	                        color: 'var(--t-text-secondary)',
	                      }}>
	                        Live lanes
	                        <span style={{ color: 'var(--t-text)' }}>{sessionTargets.length}</span>
	                      </span>
	                    </div>
	                  </div>

	                  <div style={{ position: 'relative' }}>
	                    <textarea
	                      ref={missionPromptRef}
	                      value={missionState.prompt}
	                      onChange={(event) => handleMissionPromptChange(event.target.value)}
	                      placeholder="Describe the mission. Thoughts will break it into visible work packets and let you route them into workspace lanes."
	                      style={{
	                        width: '100%',
	                        minHeight: 94,
	                        padding: '12px 14px',
	                        borderRadius: 14,
	                        border: '1px solid var(--t-input-border)',
	                        background: 'var(--t-input-bg)',
	                        fontSize: 13,
	                        color: 'var(--t-text)',
	                        resize: 'vertical',
	                        outline: 'none',
	                        fontFamily: 'inherit',
	                        lineHeight: 1.5,
	                        boxSizing: 'border-box',
	                      }}
	                    />
	                  </div>

	                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
	                    <div style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>
	                      Manual by design for v1. Queue, launch, and focus are explicit. No hidden worker spawning.
	                    </div>
	                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
	                      <button
	                        type="button"
	                        onClick={handleAddPacket}
	                        style={{
	                          border: '1px solid var(--t-panel-border)',
	                          background: 'var(--t-panel)',
	                          color: 'var(--t-text-secondary)',
	                          padding: '8px 12px',
	                          borderRadius: 12,
	                          fontSize: 11,
	                          fontWeight: 700,
	                          cursor: 'pointer',
	                        }}
	                      >
	                        Add Packet
	                      </button>
	                      <button
	                        type="button"
	                        onClick={handlePlanMission}
	                        disabled={!missionState.prompt.trim()}
	                        style={{
	                          border: 'none',
	                          background: missionState.prompt.trim() ? '#2563eb' : 'var(--t-divider)',
	                          color: missionState.prompt.trim() ? '#fff' : 'var(--t-text-faint)',
	                          padding: '8px 12px',
	                          borderRadius: 12,
	                          fontSize: 11,
	                          fontWeight: 700,
	                          cursor: missionState.prompt.trim() ? 'pointer' : 'default',
	                        }}
	                      >
	                        Plan Packets
	                      </button>
	                    </div>
	                  </div>
	                </div>

	                {missionState.summary ? (
	                  <div style={{
	                    padding: '12px 14px',
	                    borderRadius: 16,
	                    background: 'var(--t-panel)',
	                    border: '1px solid var(--t-panel-border)',
	                    boxShadow: '0 12px 28px rgba(15, 23, 42, 0.05)',
	                  }}>
	                    <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--t-text-muted)', marginBottom: 6 }}>
	                      Mission Summary
	                    </div>
	                    <div style={{ fontSize: 13, color: 'var(--t-text)', lineHeight: 1.55 }}>
	                      {missionState.summary}
	                    </div>
	                  </div>
	                ) : null}

	                {/* ── Repo Issues ── */}
                {repoIssues.length > 0 ? (
                  <div style={{
                    padding: '14px 16px',
                    borderRadius: 16,
                    background: 'var(--t-panel)',
                    border: '1px solid var(--t-panel-border)',
                    boxShadow: '0 12px 28px rgba(15, 23, 42, 0.04)',
                  }}>
                    <button
                      type="button"
                      onClick={() => setIssuesCollapsed((v) => !v)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        cursor: 'pointer',
                        marginBottom: issuesCollapsed ? 0 : 10,
                      }}
                    >
                      <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--t-text-muted)' }}>
                        Open Issues
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                          padding: '2px 7px',
                          borderRadius: 999,
                          background: 'var(--t-divider-subtle)',
                          color: 'var(--t-text-secondary)',
                          fontSize: 10,
                          fontWeight: 700,
                        }}>
                          {repoIssues.length}
                        </span>
                        <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" style={{ transform: issuesCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}>
                          <path d="M2.5 3.5L5 6L7.5 3.5" />
                        </svg>
                      </div>
                    </button>
                    {!issuesCollapsed ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {(issuesShowAll ? repoIssues : repoIssues.slice(0, 5)).map((issue) => {
                          const alreadyPacketed = missionState.packets.some(
                            (p) => p.summary.includes(`#${issue.number}`) || p.title === issue.title,
                          );
                          return (
                            <div
                              key={issue.number}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '6px 8px',
                                borderRadius: 10,
                                transition: 'background 120ms ease',
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                            >
                              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-text-muted)', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', minWidth: 36, flexShrink: 0 }}>
                                #{issue.number}
                              </span>
                              <span style={{ fontSize: 12, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                                {issue.title}
                              </span>
                              {alreadyPacketed ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                                  <button type="button" onClick={() => handleLinkIssueToPacket(issue)} title="Link to current packet"
                                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center' }}>
                                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0.5 }}>
                                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                    </svg>
                                  </button>
                                  <button type="button" onClick={() => handleRemovePacketForIssue(issue.number)} title="Remove packet"
                                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center' }}>
                                    <span style={{ fontSize: 14, color: 'var(--t-text-muted)', opacity: 0.5, lineHeight: 1 }}>-</span>
                                  </button>
                                </div>
                              ) : (
                                <button type="button" onClick={() => handleCreatePacketFromIssue(issue)} title="Create work packet"
                                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                                  <span style={{ fontSize: 14, color: 'var(--t-text-muted)', opacity: 0.5, lineHeight: 1 }}>+</span>
                                </button>
                              )}
                            </div>
                          );
                        })}
                        {repoIssues.length > 5 ? (
                          <button
                            type="button"
                            onClick={() => setIssuesShowAll((v) => !v)}
                            style={{
                              border: 'none',
                              background: 'transparent',
                              color: 'var(--t-text-muted)',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: 'pointer',
                              padding: '6px 8px',
                              textAlign: 'left',
                            }}
                          >
                            {issuesShowAll ? 'Show less' : `Show all ${repoIssues.length} issues`}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* ── Work Packets ── */}
                {missionState.packets.length === 0 ? (
                  <div style={{
                    padding: '18px 16px',
                    borderRadius: 16,
                    border: '1px dashed var(--t-panel-border)',
                    background: 'rgba(148, 163, 184, 0.06)',
                    color: 'var(--t-text-secondary)',
                    fontSize: 12,
                    lineHeight: 1.6,
                    textAlign: 'center',
                  }}>
                    Add packets from issues above, or describe a mission and plan.
                  </div>
                ) : null}

                {missionState.packets.map((packet) => {
                  const statusMeta = orchestratorStatusTone(packet.status);
                  const runtimeMeta = orchestratorRuntimeTone(packet.runtime);
                  const dependencyBlocker = packetReleaseBlockedBy(packet, missionState.packets);
                  const canLaunch = !packet.archivedAt && packet.releaseState !== 'released' && packet.queueState !== 'held' && !dependencyBlocker;
                  const isExpanded = expandedPacketId === packet.id;
                  const targetLabel = workspaceTargets.find((t) => t.localPath === packet.workspaceTargetPath)?.label ?? null;

                  return (
                    <div
                      key={packet.id}
                      style={{
                        borderRadius: 14,
                        background: 'var(--t-panel)',
                        border: '1px solid var(--t-panel-border)',
                        boxShadow: '0 8px 20px rgba(15, 23, 42, 0.04)',
                        flexShrink: 0,
                      }}
                    >
                      {/* ── Compact row: always visible ── */}
                      <button
                        type="button"
                        onClick={() => setExpandedPacketId(isExpanded ? null : packet.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          width: '100%',
                          padding: '11px 14px',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span style={{ fontSize: 10, fontWeight: 800, color: runtimeMeta.color, padding: '2px 6px', borderRadius: 5, background: runtimeMeta.background, flexShrink: 0, letterSpacing: '0.02em' }}>
                          {packet.referenceLabel}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>
                          {packet.title}
                        </span>
                        <span style={{ fontSize: 9, fontWeight: 800, color: statusMeta.color, padding: '3px 7px', borderRadius: 999, background: statusMeta.background, border: `1px solid ${statusMeta.border}`, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>
                          {statusMeta.label}
                        </span>
                        <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-muted)" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0, transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 150ms ease' }}>
                          <path d="M2.5 3.5L5 6L7.5 3.5" />
                        </svg>
                      </button>

                      {/* ── Expanded detail ── */}
                      {isExpanded ? (
                        <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--t-divider-subtle)' }}>
                          <div style={{ paddingTop: 10 }}>
                            <textarea
                              value={packet.summary}
                              onChange={(event) => patchPacket(packet.id, (current) => ({ ...current, summary: event.target.value }))}
                              placeholder="What should this packet accomplish?"
                              rows={2}
                              style={{
                                width: '100%',
                                padding: '9px 11px',
                                borderRadius: 10,
                                border: '1px solid var(--t-input-border)',
                                background: 'var(--t-input-bg)',
                                fontSize: 12,
                                color: 'var(--t-text)',
                                resize: 'vertical',
                                outline: 'none',
                                lineHeight: 1.5,
                                boxSizing: 'border-box',
                              }}
                            />
                          </div>

                          {/* Meta row */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <select
                              value={packet.runtime}
                              onChange={(event) => patchPacket(packet.id, (current) => ({ ...current, runtime: event.target.value === 'claude-code' ? 'claude-code' : 'codex' }))}
                              style={{ padding: '5px 8px', borderRadius: 8, border: '1px solid var(--t-input-border)', background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 11 }}
                            >
                              <option value="codex">Codex</option>
                              <option value="claude-code">Claude Code</option>
                            </select>
                            <select
                              value={packet.workspaceTargetPath ?? ''}
                              onChange={(event) => {
                                const nextTarget = workspaceTargets.find((t) => t.localPath === event.target.value) ?? null;
                                patchPacket(packet.id, (current) => ({ ...current, workspaceTargetPath: nextTarget?.localPath ?? null, branchTarget: nextTarget?.branch ?? current.branchTarget }));
                              }}
                              style={{ padding: '5px 8px', borderRadius: 8, border: '1px solid var(--t-input-border)', background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 11 }}
                            >
                              <option value="">No target</option>
                              {workspaceTargets.map((t) => <option key={t.id} value={t.localPath}>{t.label}</option>)}
                            </select>
                            <input
                              value={packet.branchTarget}
                              onChange={(event) => patchPacket(packet.id, (current) => ({ ...current, branchTarget: event.target.value }))}
                              placeholder="branch"
                              style={{ padding: '5px 8px', borderRadius: 8, border: '1px solid var(--t-input-border)', background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 11, outline: 'none', width: 90 }}
                            />
                          </div>

                          {/* Blocker notice */}
                          {(packet.blockedReason || dependencyBlocker) ? (
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#b91c1c', padding: '7px 10px', borderRadius: 8, background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.12)' }}>
                              {packet.blockedReason ?? `Waiting on ${dependencyBlocker?.referenceLabel}`}
                            </div>
                          ) : null}

                          {/* Actions — only what matters */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            {!packet.lane ? (
                              <button type="button" onClick={() => { void handleLaunchPacket(packet); }} disabled={!canLaunch}
                                style={{ border: 'none', background: canLaunch ? '#2563eb' : 'var(--t-divider)', color: canLaunch ? '#fff' : 'var(--t-text-faint)', padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: canLaunch ? 'pointer' : 'default' }}>
                                Launch
                              </button>
                            ) : (
                              <button type="button" onClick={() => handleFocusPacket(packet)}
                                style={{ border: 'none', background: '#2563eb', color: '#fff', padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                                Focus
                              </button>
                            )}
                            {packet.queueState !== 'held' && !packet.lane ? (
                              <button type="button" onClick={() => patchPacket(packet.id, (current) => ({ ...current, queueState: 'held', blockedReason: 'Held by operator' }))}
                                style={{ border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-secondary)', padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                                Hold
                              </button>
                            ) : packet.queueState === 'held' ? (
                              <button type="button" onClick={() => patchPacket(packet.id, (current) => ({ ...current, queueState: 'queued', blockedReason: null }))}
                                style={{ border: '1px solid rgba(239, 68, 68, 0.2)', background: 'rgba(239, 68, 68, 0.06)', color: '#b91c1c', padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                                Unhold
                              </button>
                            ) : null}
                            <button type="button"
                              onClick={() => patchPacket(packet.id, (current) => ({ ...current, archivedAt: current.archivedAt ? null : new Date().toISOString() }))}
                              style={{ border: '1px solid var(--t-panel-border)', background: 'var(--t-panel)', color: 'var(--t-text-muted)', padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer', marginLeft: 'auto' }}>
                              {packet.archivedAt ? 'Restore' : 'Archive'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* Collapsed: show subtle meta line */
                        <div style={{ padding: '0 14px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{runtimeMeta.label}</span>
                          {targetLabel ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{targetLabel}</span></> : null}
                          {packet.lane ? <><span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span><span style={{ fontSize: 10, color: '#22c55e', fontWeight: 600 }}>Live</span></> : null}
                        </div>
                      )}
                    </div>
                  );
                })}
	              </div>
	            ) : (
	              <>
	                <div style={{
	                  flex: 1,
	                  overflowY: 'auto',
	                  padding: '12px 14px 10px',
	                  display: 'flex',
	                  flexDirection: 'column',
	                  gap: 12,
	                  background: thoughtsBodyBackground,
	                }}>
	                  {chatMessages.length === 0 && !waitingForReply && (
	                    <div style={{
	                      display: 'flex',
	                      flexDirection: 'column',
	                      alignItems: 'center',
	                      justifyContent: 'center',
	                      flex: 1,
	                      gap: 12,
	                      padding: '20px 0',
	                    }}>
	                      <div style={{
	                        width: '100%',
	                        maxWidth: 340,
	                        padding: '16px 18px',
	                        borderRadius: 18,
	                        background: thoughtsElevatedSurface,
	                        border: thoughtsElevatedBorder,
	                        boxShadow: thoughtsElevatedShadow,
	                        textAlign: 'left',
	                      }}>
	                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
	                          <span style={{
	                            width: 10,
	                            height: 10,
	                            borderRadius: '50%',
	                            background: activeTargetColor,
	                            boxShadow: `0 0 0 4px ${activeTargetColor}18`,
	                          }} />
	                          <span style={{
	                            fontSize: 13,
	                            fontWeight: 700,
	                            color: 'var(--t-text)',
	                            letterSpacing: '-0.01em',
	                          }}>
	                            {activeTargetLabel}
	                          </span>
	                          <span style={{
	                            marginLeft: 'auto',
	                            fontSize: 10,
	                            fontWeight: 700,
	                            color: 'var(--t-text-muted)',
	                            textTransform: 'uppercase',
	                            letterSpacing: '0.05em',
	                          }}>
	                            Live Chat
	                          </span>
	                        </div>
	                        <div style={{
	                          fontSize: 12,
	                          color: 'var(--t-text-secondary)',
	                          lineHeight: 1.6,
	                          marginBottom: 10,
	                        }}>
	                          Intervene directly with a live Codex or Claude Code lane without leaving the planner surface.
	                        </div>
	                        <div style={{
	                          display: 'flex',
	                          flexDirection: 'column',
	                          gap: 6,
	                          fontSize: 11,
	                          color: 'var(--t-text-secondary)',
	                        }}>
	                          {targetAgent ? (
	                            <>
	                              <div>Messages stay scoped to the selected CLI lane.</div>
	                              <div>Use the picker below to redirect the conversation to another live session.</div>
	                              <div>Planner state remains in Mission Control. This chat is only for operator intervention.</div>
	                            </>
	                          ) : (
	                            <>
	                              <div>No live Codex or Claude Code lane is available right now.</div>
	                              <div>Launch a CLI lane from a workspace tab first, then come back here to steer it.</div>
	                            </>
	                          )}
	                        </div>
	                      </div>

	                      {suggestions.length > 0 ? (
	                        <div style={{ width: '100%', maxWidth: 340, display: 'flex', flexDirection: 'column', gap: 6 }}>
	                          <div style={{
	                            fontSize: 9,
	                            fontWeight: 700,
	                            textTransform: 'uppercase',
	                            color: 'var(--t-text-muted)',
	                            letterSpacing: '0.05em',
	                            padding: '0 2px',
	                          }}>
	                            Suggested
	                          </div>
	                          {suggestions.map((s, i) => (
	                            <button
	                              key={i}
	                              type="button"
	                              onClick={() => {
	                                setTargetAgentKey(s.agent.key);
	                                setInput(s.action);
	                                setTimeout(() => inputRef.current?.focus(), 50);
	                              }}
	                              style={{
	                                display: 'flex',
	                                alignItems: 'center',
	                                gap: 8,
	                                padding: '8px 10px',
	                                borderRadius: 10,
	                                textAlign: 'left',
	                                border: '1px solid var(--t-divider)',
	                                background: 'var(--t-hover)',
	                                cursor: 'pointer',
	                              }}
	                            >
	                              <span style={{
	                                width: 6,
	                                height: 6,
	                                borderRadius: '50%',
	                                flexShrink: 0,
	                                background: s.priority === 'critical' ? '#ef4444' : s.priority === 'warn' ? '#f59e0b' : 'var(--t-text-muted)',
	                              }} />
	                              <div style={{ flex: 1, minWidth: 0 }}>
	                                <div style={{ fontSize: 11, color: 'var(--t-text)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
	                                  {s.text}
	                                </div>
	                                <div style={{ fontSize: 9, color: 'var(--t-text-muted)', marginTop: 1 }}>
	                                  → {s.agent.name}
	                                </div>
	                              </div>
	                            </button>
	                          ))}
	                        </div>
	                      ) : null}
	                    </div>
	                  )}

	                  {chatMessages.map((msg, index) => (
	                    <DesktopAgentMessage
	                      key={msg.id}
	                      entry={msg}
	                      isLast={index === chatMessages.length - 1 && !waitingForReply}
	                    />
	                  ))}

	                  {waitingForReply && chatMessages.length > 0 &&
	                    chatMessages[chatMessages.length - 1]?.text?.toLowerCase().includes('compact') && (
	                      <div style={{
	                        padding: '12px 14px',
	                        borderRadius: 14,
	                        background: 'linear-gradient(180deg, rgba(254, 249, 195, 0.72), rgba(254, 240, 138, 0.22))',
	                        border: '1px solid rgba(245, 158, 11, 0.18)',
	                        display: 'flex',
	                        flexDirection: 'column',
	                        gap: 7,
	                        boxShadow: '0 12px 30px rgba(245, 158, 11, 0.08)',
	                      }}>
	                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, color: '#b45309', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
	                          <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(245, 158, 11, 0.3)', borderTopColor: '#f59e0b', animation: 'spin 1s linear infinite' }} />
	                          Compaction in progress
	                        </div>
	                        <div style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
	                          Context is being compressed. Messages sent now will be queued and delivered after compaction completes.
	                        </div>
	                      </div>
	                    )}

	                  {mode === 'chat' && waitingForReply && !(chatMessages.length > 0 &&
	                    chatMessages[chatMessages.length - 1]?.text?.toLowerCase().includes('compact')) && (
	                      <div style={{
	                        alignSelf: 'flex-start',
	                        display: 'flex',
	                        alignItems: 'center',
	                        gap: 8,
	                        padding: '10px 14px',
	                        borderRadius: 16,
	                        background: thoughtsMutedGlass,
	                        border: thoughtsElevatedBorder,
	                        boxShadow: thoughtsElevatedShadow,
	                      }}>
	                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeTargetColor, boxShadow: `0 0 0 4px ${activeTargetColor}14`, flexShrink: 0 }} />
	                        {[0, 1, 2].map((i) => (
	                          <div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--t-text-secondary)', animation: `llmDot 1.2s ease-in-out ${i * 0.18}s infinite` }} />
	                        ))}
	                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)', letterSpacing: '-0.01em' }}>
	                          {activeTargetLabel} is thinking…
	                        </span>
	                      </div>
	                    )}

	                  <div ref={chatEndRef} />
	                </div>

	                <div style={{
	                  padding: '10px 12px 12px',
	                  borderTop: '1px solid var(--t-divider-subtle)',
	                  flexShrink: 0,
	                  background: thoughtsBodyBackground,
	                }}>
	                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
	                    <div style={{ position: 'relative' }}>
	                      <button
	                        type="button"
	                        onClick={() => setAgentPickerOpen((value) => !value)}
	                        disabled={sessionTargets.length === 0}
	                        style={{
	                          display: 'flex',
	                          alignItems: 'center',
	                          gap: 6,
	                          padding: '6px 10px',
	                          borderRadius: 10,
	                          border: thoughtsElevatedBorder,
	                          background: thoughtsMutedGlass,
	                          boxShadow: thoughtsElevatedShadow,
	                          cursor: sessionTargets.length > 0 ? 'pointer' : 'default',
	                          fontSize: 11,
	                          fontWeight: 700,
	                          color: activeTargetColor,
	                          letterSpacing: '-0.01em',
	                          opacity: sessionTargets.length > 0 ? 1 : 0.6,
	                        }}
	                      >
	                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeTargetColor, display: 'block', flexShrink: 0 }} />
	                        {activeTargetLabel}
	                        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'block', transform: agentPickerOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
	                          <polyline points="6 9 12 15 18 9"/>
	                        </svg>
	                      </button>

	                      {agentPickerOpen && sessionTargets.length > 0 ? (
	                        <div style={{
	                          position: 'absolute',
	                          bottom: '100%',
	                          left: 0,
	                          marginBottom: 6,
	                          minWidth: 184,
	                          borderRadius: 14,
	                          padding: 4,
	                          background: 'var(--t-panel-translucent)',
	                          backdropFilter: 'blur(28px) saturate(180%)',
	                          WebkitBackdropFilter: 'blur(28px) saturate(180%)',
	                          border: '1px solid var(--t-panel-border)',
	                          boxShadow: 'var(--t-panel-shadow)',
	                          zIndex: 10,
	                        }}>
	                          {sessionTargets.map((agent) => (
	                            <button
	                              key={agent.key}
	                              type="button"
	                              onClick={() => {
	                                setTargetAgentKey(agent.key);
	                                setAgentPickerOpen(false);
	                                setChatMessages([]);
	                                setWaitingForReply(false);
	                                clearPolling();
	                                seenServerEntriesRef.current.clear();
	                                responseSeenRef.current = false;
	                                idlePollsRef.current = 0;
	                              }}
	                              style={{
	                                width: '100%',
	                                display: 'flex',
	                                alignItems: 'center',
	                                gap: 8,
	                                padding: '8px 10px',
	                                borderRadius: 10,
	                                border: 'none',
	                                cursor: 'pointer',
	                                textAlign: 'left',
	                                background: targetAgent?.key === agent.key ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
	                              }}
	                            >
	                              <span style={{ width: 8, height: 8, borderRadius: '50%', background: agent.color, display: 'block', flexShrink: 0 }} />
	                              <div style={{ minWidth: 0, flex: 1 }}>
	                                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{agent.name}</div>
	                                <div style={{ fontSize: 9, color: 'var(--t-text-muted)' }}>{orchestratorRuntimeTone(agent.runtime).label}</div>
	                              </div>
	                              {targetAgent?.key === agent.key ? (
	                                <div style={{ color: '#2563eb' }}>
	                                  <CheckIcon />
	                                </div>
	                              ) : null}
	                            </button>
	                          ))}
	                        </div>
	                      ) : null}
	                    </div>

	                    <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
	                        <span style={{
	                          display: 'inline-flex',
	                          alignItems: 'center',
	                          gap: 5,
	                          padding: '4px 8px',
	                          borderRadius: 999,
	                          background: thoughtsMutedGlass,
	                          border: thoughtsElevatedBorder,
	                          fontSize: 10,
	                          fontWeight: 700,
	                          color: 'var(--t-text-secondary)',
	                          textTransform: 'uppercase',
	                        }}>
	                        {targetAgentModel}
	                      </span>
	                      {typeof targetAgentContext === 'number' ? (
	                        <span style={{ fontSize: 10, color: targetAgentContext > 85 ? '#b45309' : 'var(--t-text-secondary)', fontWeight: 700 }}>
	                          {Math.round(targetAgentContext)}% ctx
	                        </span>
	                      ) : null}
	                      {targetAgentTask ? (
	                        <span style={{ minWidth: 0, flex: 1, fontSize: 10, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
	                          {targetAgentTask}
	                        </span>
	                      ) : null}
	                    </div>
	                  </div>

	                  <div style={{ position: 'relative' }}>
	                    <textarea
	                      ref={inputRef}
	                      value={input}
	                      onChange={(event) => setInput(event.target.value)}
	                      onKeyDown={(event) => {
	                        if (event.key === 'ArrowUp' && !input.trim()) {
	                          event.preventDefault();
	                          const lastUserMsg = [...chatMessages].reverse().find((message) => message.role === 'user');
	                          if (lastUserMsg) setInput(lastUserMsg.text);
	                          return;
	                        }
	                        if (event.key === 'Enter' && !event.shiftKey) {
	                          event.preventDefault();
	                          void handleTaskSend();
	                        }
	                      }}
	                      placeholder={waitingForReply ? `${activeTargetLabel} is thinking...` : `Message ${activeTargetLabel}… (↑ for recent)`}
	                      disabled={waitingForReply || !targetAgent}
	                      rows={1}
	                      style={{
	                        width: '100%',
	                        minHeight: 44,
	                        maxHeight: 120,
	                        padding: '11px 84px 11px 14px',
	                        borderRadius: 14,
	                        border: '1px solid var(--t-input-border)',
	                        background: 'var(--t-input-bg)',
	                        boxShadow: '0 14px 30px rgba(15, 23, 42, 0.08)',
	                        fontSize: 13,
	                        color: 'var(--t-text)',
	                        resize: 'none',
	                        outline: 'none',
	                        fontFamily: 'inherit',
	                        lineHeight: 1.4,
	                        boxSizing: 'border-box',
	                        opacity: waitingForReply || !targetAgent ? 0.6 : 1,
	                      }}
	                    />
	                    <InputButtons
	                      input={input}
	                      enhancing={enhancing}
	                      preEnhanceInput={preEnhanceInput}
	                      onEnhance={handleEnhance}
	                      onUndoEnhance={handleUndoEnhance}
	                      onSubmit={handleTaskSend}
	                      small
	                    />
	                  </div>

	                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 6, paddingLeft: 2, fontSize: 10, color: 'var(--t-text-faint)' }}>
	                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: activeTargetColor }} />
	                    <span style={{ fontWeight: 600 }}>{activeTargetLabel}</span>
	                    <span>·</span>
	                    <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace' }}>{activeTargetRuntimeLabel}</span>
	                    {hasAssistantActivity ? (
	                      <>
	                        <span>·</span>
	                        <span>{chatMessages.length} messages</span>
	                      </>
	                    ) : null}
	                  </div>
	                </div>
	              </>
	            )}
	          </div>
	        )}

        {/* ── Resize handles ── */}
        {!minimized && !docked && (
          <>
            <div onMouseDown={handleResizeStart('e')} style={{
              position: 'absolute', top: 20, right: -3, bottom: 20, width: 6,
              cursor: 'ew-resize', zIndex: 2,
            }} />
            <div onMouseDown={handleResizeStart('s')} style={{
              position: 'absolute', bottom: -3, left: 20, right: 20, height: 6,
              cursor: 'ns-resize', zIndex: 2,
            }} />
            <div onMouseDown={handleResizeStart('se')} style={{
              position: 'absolute', bottom: -3, right: -3, width: 14, height: 14,
              cursor: 'nwse-resize', zIndex: 3,
            }} />
            <div onMouseDown={handleResizeStart('sw')} style={{
              position: 'absolute', bottom: -3, left: -3, width: 14, height: 14,
              cursor: 'nesw-resize', zIndex: 3,
            }} />
          </>
        )}
      </div>
    </>
  );
}

// ── Compose Controls ──

function InputButtons({
  input,
  enhancing,
  preEnhanceInput,
  onEnhance,
  onUndoEnhance,
  onSubmit,
  small,
}: {
  input: string;
  enhancing: boolean;
  preEnhanceInput: string | null;
  onEnhance: () => void;
  onUndoEnhance: () => void;
  onSubmit: () => void;
  small?: boolean;
}) {
  const sz = small ? 24 : 28;
  const sendSz = small ? 26 : 30;

  return (
    <div style={{
      position: 'absolute',
      right: 6,
      bottom: 6,
      display: 'flex',
      gap: 3,
      alignItems: 'center',
    }}>
      {preEnhanceInput !== null && (
        <button type="button" onClick={onUndoEnhance} title="Undo enhancement" style={{
          width: sz, height: sz, borderRadius: 7, border: 'none',
          background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 600,
        }}>
          ↩
        </button>
      )}
      <button type="button" onClick={onEnhance} disabled={!input.trim() || enhancing}
        title="Enhance with AI" style={{
          width: sz, height: sz, borderRadius: 7, border: 'none',
          background: input.trim() ? 'rgba(37, 99, 235, 0.1)' : 'var(--t-hover)',
          color: enhancing ? '#93c5fd' : input.trim() ? '#2563eb' : 'var(--t-text-faint)',
          cursor: input.trim() && !enhancing ? 'pointer' : 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 120ms, color 120ms',
          animation: enhancing ? 'spin 1.5s ease-in-out infinite' : 'none',
        }}>
        <SparklesIcon />
      </button>
      <button type="button" onClick={onSubmit} disabled={!input.trim()} style={{
        width: sendSz, height: sendSz, borderRadius: 8, border: 'none',
        background: input.trim() ? '#2563eb' : 'var(--t-divider)',
        color: input.trim() ? '#fff' : 'var(--t-text-faint)',
        cursor: input.trim() ? 'pointer' : 'default',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 120ms',
      }}>
        <SendIcon />
      </button>
    </div>
  );
}
