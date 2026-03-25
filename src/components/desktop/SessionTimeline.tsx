'use client';
/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- timeline keeps temporary drill state during ongoing redesign */

/**
 * SessionTimeline — Day-level activity bar below the TitleBar.
 *
 * Shows the ENTIRE DAY across all agents. Hover to see a vertical
 * scrubber line with timestamp. Click expand to open the full
 * timeline Canvas tab.
 *
 * Fetches real data from /api/panel/timeline.
 * For the product surface, do not fall back to mock activity.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { AgentSummary } from '@/lib/fleet/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import { appendOpenClawBetaQuery, readOpenClawBetaEnabled, subscribeOpenClawBetaEnabled } from '@/lib/connectors/openclaw-beta';

// ── Types ──

export type SegmentKind = 'thinking' | 'coding' | 'testing' | 'error' | 'idle';

export interface TimelineSegment {
  kind: SegmentKind;
  startMin: number;
  durationMin: number;
  label?: string;
  agent?: string;
}

// ── Constants ──

export const SEGMENT_COLORS: Record<SegmentKind, string> = {
  coding: '#2563eb',
  thinking: '#93c5fd',
  testing: '#f59e0b',
  error: '#ef4444',
  idle: '#e5e7eb',
};

export const SEGMENT_LABELS: Record<SegmentKind, string> = {
  thinking: 'THINKING',
  coding: 'CODING',
  testing: 'TESTING',
  error: 'ERRORS',
  idle: 'IDLE',
};

const DRILL_LEFT_GUTTER = 72;
const DRILL_TOP_GUTTER = 82;
const DRILL_MIN_WIDTH = 340;
const DRILL_MAX_WIDTH = 720;
const DRILL_MIN_HEIGHT = 320;
const DRILL_MAX_HEIGHT = 680;
const DEFAULT_TIMELINE_REPO = 'hurttlocker/cortex-ide';
// Intentionally disabled for v0.001.0 to keep the customer surface simpler.
// Keep the drill-down implementation in place so we can restore it after the UX pass.
const TIMELINE_DRILLDOWN_ENABLED = false;

// ── Helpers ──

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatTime(minutesSinceAnchor: number): string {
  // Anchor is 6 AM (matches API route rolling window)
  const h = 6 + Math.floor(minutesSinceAnchor / 60);
  const m = minutesSinceAnchor % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function runtimeLabel(runtime: string | null | undefined): string {
  if (runtime === 'openclaw') return 'OpenClaw';
  if (runtime === 'claude-code') return 'Claude Code';
  if (runtime === 'codex') return 'Codex';
  return runtime || 'Runtime';
}

function compactWorkspacePath(path: string | null | undefined): string | null {
  if (!path || path === 'unknown') return null;
  const normalized = path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 4) return normalized;
  return `~/${parts.slice(-4).join('/')}`;
}

function cleanTaskLabel(task: string | null | undefined): string | null {
  if (!task) return null;
  return task
    .replace(/^IDE-owned Codex session ready for the next input via resume\.?\s*/i, '')
    .replace(/^Live Codex terminal verified via pid\/log mapping on s\d+\.\s*/i, '')
    .replace(/^Live Codex terminal detected on s\d+\.\s*/i, '')
    .replace(/^Existing OpenClaw session mirrored into the control plane\.?\s*/i, '')
    .replace(/^Shared channel surface attached to the same OpenClaw runtime\.?\s*/i, '')
    .replace(/^Recent automation surface; useful for visibility, not the primary operator lane\.?\s*/i, '')
    .replace(/^Mirroring the live Q ↔ Mister conversation, not spawning a fresh session\.?\s*/i, '')
    .trim();
}

function timelineMatchesAgent(agentName: string, session: AgentSummary): boolean {
  const key = session.sessionKey.toLowerCase();
  const name = (session.name || '').toLowerCase();
  if (agentName === 'Main') return session.runtime === 'openclaw' && key.startsWith('agent:main:');
  if (agentName === 'Agent 2') return session.runtime === 'openclaw' && (key.startsWith('agent:ace:') || name.includes('ace'));
  if (agentName === 'Agent 3') return session.runtime === 'openclaw' && (key.startsWith('agent:hawk:') || name.includes('hawk'));
  if (agentName === 'codex') return session.runtime === 'codex';
  const loweredAgent = agentName.toLowerCase();
  return name.includes(loweredAgent) || key.includes(loweredAgent);
}

function timelinePrimarySession(sessions: AgentSummary[]): AgentSummary | null {
  if (sessions.length === 0) return null;
  const statusWeight = (status: string) => {
    switch (status) {
      case 'running': return 4;
      case 'reviewing': return 3;
      case 'waiting': return 2;
      case 'idle': return 1;
      default: return 0;
    }
  };
  return [...sessions].sort((a, b) => {
    if (Boolean(a.isCurrentSession) !== Boolean(b.isCurrentSession)) return a.isCurrentSession ? -1 : 1;
    const delta = statusWeight(b.status) - statusWeight(a.status);
    if (delta !== 0) return delta;
    return new Date(b.lastEventAt || 0).getTime() - new Date(a.lastEventAt || 0).getTime();
  })[0] ?? null;
}

// ── Data fetching ──

function useTimelineData() {
  const [segments, setSegments] = useState<TimelineSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [openClawBetaEnabled, setOpenClawBetaEnabled] = useState(() => readOpenClawBetaEnabled());

  useEffect(() => subscribeOpenClawBetaEnabled(setOpenClawBetaEnabled), []);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(appendOpenClawBetaQuery('/api/panel/timeline', openClawBetaEnabled));
      if (res.ok) {
        const data = await res.json();
        if (data.segments?.length > 0) {
          setSegments(data.segments);
          // Cache in sessionStorage
          try { sessionStorage.setItem('cortex-timeline', JSON.stringify({ ts: Date.now(), segments: data.segments })); } catch {}
          setLoading(false);
          return;
        }
      }
    } catch {}
    // Fallback: try cache only. Product UI should not display invented activity.
    try {
      const cached = sessionStorage.getItem('cortex-timeline');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.ts < 300_000 && parsed.segments?.length > 0) {
          setSegments(parsed.segments);
          setLoading(false);
          return;
        }
      }
    } catch {}
    setSegments([]);
    setLoading(false);
  }, [openClawBetaEnabled]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60_000); // refresh every 60s
    return () => clearInterval(interval);
  }, [fetchData]);

  return { segments, loading };
}

function useTimelineSessions() {
  const [sessions, setSessions] = useState<AgentSummary[]>([]);
  const [openClawBetaEnabled, setOpenClawBetaEnabled] = useState(() => readOpenClawBetaEnabled());

  useEffect(() => subscribeOpenClawBetaEnabled(setOpenClawBetaEnabled), []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(appendOpenClawBetaQuery('/api/mobile/inbox', openClawBetaEnabled));
      if (!res.ok) return;
      const data = await res.json() as MobileInboxSnapshot;
      setSessions(data.sessions ?? []);
    } catch {
      // silent
    }
  }, [openClawBetaEnabled]);

  useEffect(() => {
    void fetchSessions();
    const interval = setInterval(fetchSessions, 30_000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  return sessions;
}

// ── Inline SVG Icons ──

function PlayIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block' }}>
      <polygon points="5,3 19,12 5,21" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" />
    </svg>
  );
}

// ── Small round button ──

function TimelineButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        width: 24, height: 24, borderRadius: 12, border: 'none',
        background: 'var(--t-divider)', color: 'var(--t-text)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', transition: 'background 120ms', flexShrink: 0, padding: 0,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--t-divider)'; }}
    >
      {icon}
    </button>
  );
}

// ── Component ──

export function SessionTimeline({ onExpand }: { onExpand?: () => void }) {
  const { segments, loading } = useTimelineData();
  const liveSessions = useTimelineSessions();
  const barRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverMin, setHoverMin] = useState<number | null>(null);
  const [hoverClientX, setHoverClientX] = useState<number | null>(null);
  const [hoverBarTop, setHoverBarTop] = useState<number>(0);

  // totalSpan = end time of last segment (for time display)
  const totalSpan = useMemo(() => {
    if (segments.length === 0) return 0;
    const last = segments[segments.length - 1];
    return last.startMin + last.durationMin;
  }, [segments]);

  // totalRendered = sum of all durations (what flex actually distributes).
  // Segments can overlap in time, so sum(durations) ≠ totalSpan.
  // The flex bar divides space by this sum, so hover math must use it too.
  const totalRendered = useMemo(() => {
    return segments.reduce((sum, s) => sum + s.durationMin, 0);
  }, [segments]);

  const kindTotals = useMemo(() => {
    const totals: Partial<Record<SegmentKind, number>> = {};
    for (const seg of segments) {
      totals[seg.kind] = (totals[seg.kind] || 0) + seg.durationMin;
    }
    return totals;
  }, [segments]);

  // Precompute cumulative pixel positions for each segment.
  // Segments are rendered as flex children occupying a % of the bar.
  // We calculate what fraction of the bar each segment covers and
  // build a lookup table so cursor position → segment is O(1).
  // Segment ranges use totalRendered (matches flex layout exactly)
  const segmentRanges = useMemo(() => {
    if (totalRendered === 0) return [];
    let cumPct = 0;
    return segments.map((seg) => {
      const startPct = cumPct;
      const widthPct = seg.durationMin / totalRendered;
      cumPct += widthPct;
      return { startPct, endPct: cumPct };
    });
  }, [segments, totalRendered]);

  const [hoveredSegIdx, setHoveredSegIdx] = useState<number | null>(null);

  // ── Drill-down modal state ──
  const [drillOpen, setDrillOpen] = useState(false);
  const [drillPos, setDrillPos] = useState({ x: DRILL_LEFT_GUTTER, y: DRILL_TOP_GUTTER });
  const [drillSize, setDrillSize] = useState({ w: 520, h: 400 });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; originW: number; originH: number } | null>(null);

  // ── Connected session panel state ──
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [sessionPanelPos, setSessionPanelPos] = useState({ x: 0, y: 0 });
  const sessionDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const agentCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const sessionPanelRef = useRef<HTMLDivElement>(null);
  // Force re-render connector line during drags
  const [, forceUpdate] = useState(0);
  const tickDrag = useCallback(() => forceUpdate(n => n + 1), []);

  interface AgentSession { id: string; label: string; model: string; startTime: string; duration: string; messages: number; status: string; cost?: number; inputTokens?: number; outputTokens?: number; cacheTokens?: number; active?: boolean }
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [agentTotalCost, setAgentTotalCost] = useState<number>(0);

  // ── Issue assignment panel state ──
  interface GHIssue { number: number; title: string; labels: (string | { name: string; color?: string })[]; state: string }
  const [issuesPanelOpen, setIssuesPanelOpen] = useState(false);
  const [issuesPanelPos, setIssuesPanelPos] = useState({ x: 0, y: 0 });
  const issuesDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const issuesPanelRef = useRef<HTMLDivElement>(null);
  const [ghIssues, setGhIssues] = useState<GHIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [assigningIssue, setAssigningIssue] = useState<number | null>(null);
  const sessionPanelElRef = useRef<HTMLDivElement>(null);

  const clampDrillWidth = useCallback((width: number) => {
    if (typeof window === 'undefined') return Math.min(Math.max(width, DRILL_MIN_WIDTH), DRILL_MAX_WIDTH);
    const sessionPanelAllowance = 380 + 32 + 24;
    const maxByViewport = Math.max(
      DRILL_MIN_WIDTH,
      Math.min(DRILL_MAX_WIDTH, window.innerWidth - DRILL_LEFT_GUTTER - sessionPanelAllowance),
    );
    return Math.min(Math.max(width, DRILL_MIN_WIDTH), maxByViewport);
  }, []);

  const clampDrillHeight = useCallback((height: number) => {
    if (typeof window === 'undefined') return Math.min(Math.max(height, DRILL_MIN_HEIGHT), DRILL_MAX_HEIGHT);
    const maxByViewport = Math.max(DRILL_MIN_HEIGHT, Math.min(DRILL_MAX_HEIGHT, window.innerHeight - DRILL_TOP_GUTTER - 48));
    return Math.min(Math.max(height, DRILL_MIN_HEIGHT), maxByViewport);
  }, []);

  const handleBarDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!TIMELINE_DRILLDOWN_ENABLED) return;
    // Anchor activity rail to the left so follow-on drill panels always have room on the right.
    setDrillPos({ x: DRILL_LEFT_GUTTER, y: DRILL_TOP_GUTTER });
    setDrillSize((current) => ({
      w: clampDrillWidth(current.w),
      h: clampDrillHeight(current.h),
    }));
    setDrillOpen(true);
  }, [clampDrillHeight, clampDrillWidth]);

  // Drag handler for modal
  const handleDrillDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: drillPos.x, originY: drillPos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setDrillPos({
        x: dragRef.current.originX + (ev.clientX - dragRef.current.startX),
        y: dragRef.current.originY + (ev.clientY - dragRef.current.startY),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [drillPos]);

  const handleDrillResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originW: drillSize.w,
      originH: drillSize.h,
    };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const nextW = clampDrillWidth(resizeRef.current.originW + (ev.clientX - resizeRef.current.startX));
      const nextH = clampDrillHeight(resizeRef.current.originH + (ev.clientY - resizeRef.current.startY));
      setDrillSize({ w: nextW, h: nextH });
      if (selectedAgent) {
        setSessionPanelPos((current) => ({ ...current, x: drillPos.x + nextW + 32 }));
        if (issuesPanelOpen) {
          setIssuesPanelPos((current) => ({ ...current, x: drillPos.x + nextW + 32 + 400 }));
        }
      }
      tickDrag();
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [clampDrillHeight, clampDrillWidth, drillPos.x, drillSize.h, drillSize.w, issuesPanelOpen, selectedAgent, tickDrag]);

  // Agent card click → open connected session panel
  const handleAgentClick = useCallback((agentName: string) => {
    if (selectedAgent === agentName) {
      setSelectedAgent(null);
      return;
    }
    // Position session panel to the right of the drill-down
    const cardEl = agentCardRefs.current.get(agentName);
    const cardRect = cardEl?.getBoundingClientRect();
    setSessionPanelPos({
      x: drillPos.x + drillSize.w + 32,
      y: cardRect ? cardRect.top - 20 : drillPos.y,
    });
    setSelectedAgent(agentName);

    // Fetch sessions + costs for this agent
    setSessionsLoading(true);
    setAgentSessions([]);
    setAgentTotalCost(0);

    // Fetch cost data from JSONL transcripts
    fetch(`/api/panel/session-costs?agent=${encodeURIComponent(agentName)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.sessions?.length > 0) {
          const sessions: AgentSession[] = data.sessions.map((s: { id: string; model: string; messages: number; cost: number; inputTokens: number; outputTokens: number; cacheTokens: number; active?: boolean }) => ({
            id: s.id,
            label: s.id.slice(0, 8),
            model: s.model || '',
            startTime: '',
            duration: '',
            messages: s.messages,
            status: s.active ? 'active' : 'idle',
            active: s.active,
            cost: s.cost,
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            cacheTokens: s.cacheTokens,
          }));
          setAgentSessions(sessions);
          setAgentTotalCost(data.byAgent?.[agentName]?.cost || 0);
        } else {
          // Fallback: derive from segments
          const agentSegs = segments.filter(s => s.agent === agentName);
          if (agentSegs.length > 0) {
            const firstSeg = agentSegs[0];
            const totalMin = agentSegs.reduce((s, x) => s + x.durationMin, 0);
            setAgentSessions([{
              id: `derived-${agentName}`,
              label: `${agentName} — Today`,
              model: '',
              startTime: formatTime(firstSeg.startMin),
              duration: formatDuration(totalMin),
              messages: agentSegs.length,
              status: 'active',
            }]);
          }
        }
      })
      .catch(() => {})
      .finally(() => setSessionsLoading(false));
  }, [selectedAgent, drillPos, drillSize, segments]);

  // Session panel drag
  const handleSessionDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sessionDragRef.current = { startX: e.clientX, startY: e.clientY, originX: sessionPanelPos.x, originY: sessionPanelPos.y };
    const onMove = (ev: MouseEvent) => {
      if (!sessionDragRef.current) return;
      setSessionPanelPos({
        x: sessionDragRef.current.originX + (ev.clientX - sessionDragRef.current.startX),
        y: sessionDragRef.current.originY + (ev.clientY - sessionDragRef.current.startY),
      });
      tickDrag();
    };
    const onUp = () => {
      sessionDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sessionPanelPos, tickDrag]);

  // Also tick connector when drill panel drags
  const handleDrillDragStartWrapped = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: drillPos.x, originY: drillPos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setDrillPos({
        x: dragRef.current.originX + (ev.clientX - dragRef.current.startX),
        y: dragRef.current.originY + (ev.clientY - dragRef.current.startY),
      });
      tickDrag();
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [drillPos, tickDrag]);

  // Agent → repo mapping for issue fetching
  const agentRepoMap: Record<string, string> = {
    Main: DEFAULT_TIMELINE_REPO,
    'Agent 2': DEFAULT_TIMELINE_REPO,
    'Agent 3': DEFAULT_TIMELINE_REPO,
    codex: DEFAULT_TIMELINE_REPO,
    Mister: DEFAULT_TIMELINE_REPO,
    Niot: 'hurttlocker/cortex',
    Hawk: 'hurttlocker/cortex',
  };

  const resolveAgentRepo = useCallback((agentName: string | null) => {
    if (!agentName) return DEFAULT_TIMELINE_REPO;
    return agentRepoMap[agentName] || DEFAULT_TIMELINE_REPO;
  }, []);

  // Open issues panel — spawns to the right of session panel
  const handleOpenIssues = useCallback(() => {
    setIssuesPanelPos({
      x: sessionPanelPos.x + 392,
      y: sessionPanelPos.y,
    });
    setIssuesPanelOpen(true);
    setIssuesLoading(true);
    const repo = resolveAgentRepo(selectedAgent);
    fetch(`/api/panel/issues?repo=${encodeURIComponent(repo)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.issues) {
          setGhIssues(data.issues.filter((i: GHIssue) => i.state.toLowerCase() === 'open').slice(0, 20));
        }
      })
      .catch(() => {})
      .finally(() => setIssuesLoading(false));
  }, [resolveAgentRepo, selectedAgent, sessionPanelPos]);

  // Issues panel drag
  const handleIssuesDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    issuesDragRef.current = { startX: e.clientX, startY: e.clientY, originX: issuesPanelPos.x, originY: issuesPanelPos.y };
    const onMove = (ev: MouseEvent) => {
      if (!issuesDragRef.current) return;
      setIssuesPanelPos({
        x: issuesDragRef.current.originX + (ev.clientX - issuesDragRef.current.startX),
        y: issuesDragRef.current.originY + (ev.clientY - issuesDragRef.current.startY),
      });
      tickDrag();
    };
    const onUp = () => {
      issuesDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [issuesPanelPos, tickDrag]);

  // Assign issue to agent
  const handleAssignIssue = useCallback(async (issueNumber: number) => {
    if (!selectedAgent) return;
    setAssigningIssue(issueNumber);
    const repo = resolveAgentRepo(selectedAgent);
    try {
      await fetch('/api/panel/assign-issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: issueNumber, agent: selectedAgent, repo }),
      });
      // Remove from list after assignment
      setGhIssues(prev => prev.filter(i => i.number !== issueNumber));
    } catch { /* silent */ }
    finally { setAssigningIssue(null); }
  }, [resolveAgentRepo, selectedAgent]);

  // Close child panels when parent closes
  useEffect(() => {
    if (!drillOpen) { setSelectedAgent(null); setIssuesPanelOpen(false); }
  }, [drillOpen]);
  useEffect(() => {
    if (!selectedAgent) setIssuesPanelOpen(false);
  }, [selectedAgent]);

  // Group segments by agent for drill-down
  const agentBreakdown = useMemo(() => {
    const map = new Map<string, { agent: string; segments: TimelineSegment[]; totalMin: number; breakdown: Partial<Record<SegmentKind, number>> }>();
    for (const seg of segments) {
      const agent = seg.agent || 'Unknown';
      if (!map.has(agent)) map.set(agent, { agent, segments: [], totalMin: 0, breakdown: {} });
      const entry = map.get(agent)!;
      entry.segments.push(seg);
      entry.totalMin += seg.durationMin;
      entry.breakdown[seg.kind] = (entry.breakdown[seg.kind] || 0) + seg.durationMin;
    }
    return Array.from(map.values()).sort((a, b) => b.totalMin - a.totalMin);
  }, [segments]);

  const liveAgentContext = useMemo(() => {
    const contexts = new Map<string, {
      runtime: string;
      status: string;
      label: string;
      summary: string;
      location: string | null;
      count: number;
      extra: string | null;
    }>();

    for (const entry of agentBreakdown) {
      const matches = liveSessions.filter((session) => timelineMatchesAgent(entry.agent, session));
      const primary = timelinePrimarySession(matches);
      if (!primary) continue;

      const repoSlug = primary.runtimeSurface?.reviewContext?.repoSlug || '';
      const repoName = repoSlug.split('/')[1] || null;
      const cleanTask = cleanTaskLabel(primary.currentTask);
      const location = repoName
        ? `${repoName}${primary.branch ? ` · ${primary.branch}` : ''}`
        : compactWorkspacePath(primary.workspace) ?? primary.surfaceLabel ?? primary.branch ?? null;
      const label = primary.surfaceLabel || primary.name || runtimeLabel(primary.runtime);
      const extra = matches.length > 1 ? `+${matches.length - 1} more` : null;

      contexts.set(entry.agent, {
        runtime: runtimeLabel(primary.runtime),
        status: primary.status,
        label,
        summary: cleanTask || primary.surfaceLabel || primary.name || 'No current task detail',
        location,
        count: matches.length,
        extra,
      });
    }

    return contexts;
  }, [agentBreakdown, liveSessions]);

  const handleBarMouseMove = useCallback((e: React.MouseEvent) => {
    if (!barRef.current || totalRendered === 0) return;
    const rect = barRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));

    // Find segment at this pixel position (matches flex layout)
    let foundIdx: number | null = null;
    for (let i = 0; i < segmentRanges.length; i++) {
      if (pct >= segmentRanges[i].startPct && pct < segmentRanges[i].endPct) {
        foundIdx = i;
        break;
      }
    }

    // Compute the actual time from the segment's real startMin
    let min: number;
    if (foundIdx !== null) {
      const seg = segments[foundIdx];
      const range = segmentRanges[foundIdx];
      // How far into this segment (0-1)
      const withinPct = (pct - range.startPct) / (range.endPct - range.startPct);
      min = Math.round(seg.startMin + withinPct * seg.durationMin);
    } else {
      // Fallback: linear interpolation across total span
      min = Math.round(pct * totalSpan);
    }

    setHoverX(x);
    setHoverMin(min);
    setHoveredSegIdx(foundIdx);
    setHoverClientX(e.clientX);
    setHoverBarTop(rect.top);
  }, [totalRendered, totalSpan, segmentRanges, segments]);

  const handleBarMouseLeave = useCallback(() => {
    setHoverX(null);
    setHoverMin(null);
    setHoveredSegIdx(null);
    setHoverClientX(null);
  }, []);

  if (loading || totalRendered === 0) return null;

  return (
    <div style={{
      height: 36,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px 0 90px',
      gap: 12,
      background: 'var(--t-chrome-timeline)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      borderBottom: '1px solid var(--t-divider-subtle)',
      fontSize: 11,
      fontWeight: 500,
      color: 'var(--t-text-secondary)',
      letterSpacing: '-0.01em',
      position: 'relative',
      zIndex: 100,
    }}>
      {/* Left — Play + Expand + Label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap' }}>
        <TimelineButton icon={<PlayIcon />} label="Play session replay" />
        {onExpand && <TimelineButton icon={<ExpandIcon />} label="Expand timeline" onClick={onExpand} />}
        <span style={{ fontWeight: 600, color: 'var(--t-text)', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em' }}>
          Today: {formatDuration(totalSpan)}
        </span>
      </div>

      {/* Center — Segmented bar with hover scrubber */}
      <div
        ref={barRef}
        onMouseMove={handleBarMouseMove}
        onMouseLeave={handleBarMouseLeave}
        onDoubleClick={TIMELINE_DRILLDOWN_ENABLED ? handleBarDoubleClick : undefined}
        style={{
          flex: 1,
          height: 18,
          borderRadius: 4,
          overflow: 'visible',
          display: 'flex',
          background: 'var(--t-timeline-bar)',
          position: 'relative',
          cursor: TIMELINE_DRILLDOWN_ENABLED ? 'crosshair' : 'default',
        }}
      >
        {/* Segments */}
        {segments.map((seg, i) => {
          const widthPct = (seg.durationMin / totalRendered) * 100;
          const isHovered = hoveredSegIdx === i;
          return (
            <div
              key={i}
              style={{
                width: `${widthPct}%`,
                height: '100%',
                background: SEGMENT_COLORS[seg.kind],
                opacity: isHovered ? 1 : 0.75,
                transition: 'opacity 60ms ease-out',
                borderRight: i < segments.length - 1 ? '1px solid rgba(255,255,255,0.25)' : 'none',
                borderRadius: i === 0 ? '4px 0 0 4px' : i === segments.length - 1 ? '0 4px 4px 0' : 0,
              }}
            />
          );
        })}

        {/* Hover scrubber line + badges */}
        {hoverX !== null && hoverMin !== null && (() => {
          const seg = hoveredSegIdx !== null ? segments[hoveredSegIdx] : null;
          const lineColor = seg ? SEGMENT_COLORS[seg.kind] : 'var(--t-text)';
          const badgeBg = seg ? SEGMENT_COLORS[seg.kind] : 'var(--t-text)';
          const kindLabel = seg ? SEGMENT_LABELS[seg.kind] : '';
          const durLabel = seg ? formatDuration(seg.durationMin) : '';
          const agentLabel = seg?.agent ? ` · ${seg.agent}` : '';

          return (
            <>
              {/* Vertical line — colored to match segment */}
              <div style={{
                position: 'absolute',
                left: hoverX,
                top: -6,
                bottom: -6,
                width: 2,
                background: lineColor,
                borderRadius: 1,
                pointerEvents: 'none',
                zIndex: 5,
                boxShadow: `0 0 6px ${lineColor}40`,
              }} />
              {/* Single bottom tooltip — time + segment info */}
              <div style={{
                position: 'absolute',
                left: hoverX,
                top: '100%',
                transform: 'translateX(-50%)',
                marginTop: 6,
                padding: '4px 10px',
                borderRadius: 8,
                background: lineColor,
                color: (seg?.kind === 'thinking') ? '#1e3a5f' : '#fff',
                fontSize: 10,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                zIndex: 10,
                boxShadow: `0 2px 10px ${lineColor}50`,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                letterSpacing: '0.01em',
              }}>
                <span>{formatTime(hoverMin)}</span>
                {seg && (
                  <>
                    <span style={{ opacity: 0.5 }}>·</span>
                    <span>{kindLabel}</span>
                    <span style={{ opacity: 0.6, fontWeight: 500 }}>{durLabel}{agentLabel}</span>
                  </>
                )}
              </div>
            </>
          );
        })()}

        {/* Time markers removed — hover tooltip shows time on demand (cleaner) */}
      </div>

      {/* Right — Legend dots */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        {(['thinking', 'coding', 'testing', 'error'] as SegmentKind[]).map((kind) => {
          const total = kindTotals[kind];
          if (!total) return null;
          return (
            <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, background: SEGMENT_COLORS[kind], flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>{formatDuration(total)}</span>
            </div>
          );
        })}
      </div>

      {/* ── Agent Drill-Down Modal (glass, draggable) ── */}
      {TIMELINE_DRILLDOWN_ENABLED && drillOpen && typeof document !== 'undefined' && createPortal(
        <>
          {/* Backdrop */}
          <div
            onClick={() => setDrillOpen(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 9998,
              background: 'rgba(0, 0, 0, 0.05)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
            }}
          />
          {/* Modal */}
          <div style={{
            position: 'fixed',
            left: drillPos.x,
            top: drillPos.y,
            width: drillSize.w,
            maxHeight: drillSize.h,
            zIndex: 9999,
            background: 'rgba(255, 255, 255, 0.18)',
            backdropFilter: 'blur(80px) saturate(2.2)',
            WebkitBackdropFilter: 'blur(80px) saturate(2.2)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: 16,
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.08), 0 8px 32px rgba(0, 0, 0, 0.04), inset 0 0.5px 0 rgba(255, 255, 255, 0.4), inset 0 -0.5px 0 rgba(255, 255, 255, 0.1)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            animation: 'drillFadeIn 180ms cubic-bezier(0.32, 0.72, 0, 1)',
          }}>
            {/* Header — draggable */}
            <div
              onMouseDown={handleDrillDragStartWrapped}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px 10px',
                cursor: 'grab',
                userSelect: 'none',
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
                  Agent Activity
                </span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontWeight: 500 }}>
                  Today · {formatDuration(totalSpan)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setDrillOpen(false)}
                aria-label="Close"
                style={{
                  width: 24, height: 24, borderRadius: 12,
                  border: 'none', background: 'rgba(255,255,255,0.12)',
                  color: 'var(--t-text-muted)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, fontWeight: 600, lineHeight: 1,
                  transition: 'background 120ms',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
              >
                ×
              </button>
            </div>

            {/* Content — per-agent breakdown */}
            <div style={{
              padding: '12px 16px 16px',
              overflowY: 'auto',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}>
              {agentBreakdown.map((entry) => {
                const context = liveAgentContext.get(entry.agent);
                const runtimeTone = context?.runtime === 'OpenClaw'
                  ? '#2563eb'
                  : context?.runtime === 'Claude Code'
                    ? '#8b5cf6'
                    : context?.runtime === 'Codex'
                      ? '#16a34a'
                      : '#64748b';

                return (
                  <div
                    key={entry.agent}
                    ref={(el) => { if (el) agentCardRefs.current.set(entry.agent, el); }}
                    onClick={() => handleAgentClick(entry.agent)}
                    style={{
                      background: selectedAgent === entry.agent ? 'rgba(37, 99, 235, 0.12)' : 'rgba(255, 255, 255, 0.1)',
                      border: selectedAgent === entry.agent ? '1px solid rgba(37, 99, 235, 0.3)' : '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: 12,
                      padding: 12,
                      cursor: 'pointer',
                      transition: 'all 150ms cubic-bezier(0.32, 0.72, 0, 1)',
                    }}
                    onMouseEnter={(e) => { if (selectedAgent !== entry.agent) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.18)'; }}
                    onMouseLeave={(e) => { if (selectedAgent !== entry.agent) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: context ? 6 : 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <div style={{
                          width: 24, height: 24, borderRadius: 8,
                          background: 'rgba(37, 99, 235, 0.12)',
                          border: '1px solid rgba(37, 99, 235, 0.2)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 11, fontWeight: 700, color: '#2563eb',
                          flexShrink: 0,
                        }}>
                          {entry.agent[0]}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
                            {entry.agent}
                          </div>
                          {context?.label ? (
                            <div
                              style={{
                                fontSize: 10,
                                color: 'var(--t-text-muted)',
                                marginTop: 1,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: 260,
                              }}
                            >
                              {context.label}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <span style={{
                        fontSize: 11, fontWeight: 600, color: 'var(--t-text-muted)',
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                        flexShrink: 0,
                      }}>
                        {formatDuration(entry.totalMin)}
                      </span>
                    </div>

                    {context ? (
                      <>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                          <span style={{
                            fontSize: 9,
                            fontWeight: 700,
                            color: runtimeTone,
                            background: `${runtimeTone}14`,
                            border: `1px solid ${runtimeTone}24`,
                            borderRadius: 999,
                            padding: '2px 6px',
                          }}>
                            {context.runtime}
                          </span>
                          {context.location ? (
                            <span style={{
                              fontSize: 9,
                              fontWeight: 600,
                              color: 'var(--t-text-secondary)',
                              background: 'rgba(255,255,255,0.16)',
                              border: '1px solid rgba(255,255,255,0.16)',
                              borderRadius: 999,
                              padding: '2px 6px',
                              fontFamily: '"SF Mono", ui-monospace, monospace',
                            }}>
                              {context.location}
                            </span>
                          ) : null}
                          {context.extra ? (
                            <span style={{
                              fontSize: 9,
                              fontWeight: 600,
                              color: 'var(--t-text-muted)',
                              background: 'rgba(255,255,255,0.12)',
                              border: '1px solid rgba(255,255,255,0.14)',
                              borderRadius: 999,
                              padding: '2px 6px',
                            }}>
                              {context.extra}
                            </span>
                          ) : null}
                        </div>
                        <div
                          style={{
                            fontSize: 10.5,
                            lineHeight: 1.45,
                            color: 'var(--t-text-secondary)',
                            marginBottom: 9,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {context.summary}
                        </div>
                      </>
                    ) : (
                      <div
                        style={{
                          fontSize: 10.5,
                          lineHeight: 1.45,
                          color: 'var(--t-text-muted)',
                          marginBottom: 9,
                        }}
                      >
                        No live surface matched for this agent right now. Timeline is showing historical activity only.
                      </div>
                    )}

                    <div style={{
                      height: 10, borderRadius: 5, overflow: 'hidden',
                      display: 'flex', background: 'rgba(255, 255, 255, 0.08)',
                    }}>
                      {entry.segments.map((seg, i) => {
                        const agentTotal = entry.segments.reduce((s, x) => s + x.durationMin, 0);
                        const pct = (seg.durationMin / agentTotal) * 100;
                        return (
                          <div
                            key={i}
                            title={`${SEGMENT_LABELS[seg.kind]} — ${formatDuration(seg.durationMin)}${seg.label ? ` · ${seg.label}` : ''}`}
                            style={{
                              width: `${pct}%`,
                              height: '100%',
                              background: SEGMENT_COLORS[seg.kind],
                              opacity: 0.85,
                              transition: 'opacity 120ms',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.85'; }}
                          />
                        );
                      })}
                    </div>

                    <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                      {(['coding', 'thinking', 'testing', 'error'] as SegmentKind[]).map((kind) => {
                        const mins = entry.breakdown[kind];
                        if (!mins) return null;
                        return (
                          <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <div style={{ width: 6, height: 6, borderRadius: 3, background: SEGMENT_COLORS[kind] }} />
                            <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontWeight: 500 }}>
                              {SEGMENT_LABELS[kind]} {formatDuration(mins)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {agentBreakdown.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 12, padding: 20 }}>
                  No agent activity yet today
                </div>
              )}
            </div>

            {/* Bottom-right resize grip */}
            <button
              type="button"
              onMouseDown={handleDrillResizeStart}
              aria-label="Resize activity panel"
              style={{
                position: 'absolute',
                right: 10,
                bottom: 10,
                width: 18,
                height: 18,
                padding: 0,
                border: 'none',
                borderRadius: 9,
                background: 'rgba(255,255,255,0.14)',
                cursor: 'nwse-resize',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--t-text-faint)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.32)',
              }}
            >
              <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <path d="M3 7L7 3" />
                <path d="M5 7L7 5" />
                <path d="M7 7L7 7" />
              </svg>
            </button>
          </div>

          {/* ── SVG Connector Line ── */}
          {selectedAgent && (() => {
            const cardEl = agentCardRefs.current.get(selectedAgent);
            const panelEl = sessionPanelRef.current;
            if (!cardEl) return null;
            const cardRect = cardEl.getBoundingClientRect();
            const panelX = sessionPanelPos.x;
            const panelY = sessionPanelPos.y;

            // Anchor points
            const x1 = cardRect.right + 2;
            const y1 = cardRect.top + cardRect.height / 2;
            const x2 = panelX;
            const y2 = panelY + 30; // ~header center
            const cpOffset = Math.min(80, Math.abs(x2 - x1) * 0.4);

            return (
              <svg
                style={{
                  position: 'fixed', inset: 0,
                  width: '100vw', height: '100vh',
                  pointerEvents: 'none', zIndex: 9998,
                }}
              >
                <defs>
                  <linearGradient id="connectorGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#2563eb" stopOpacity="0.6" />
                    <stop offset="100%" stopColor="#2563eb" stopOpacity="0.3" />
                  </linearGradient>
                </defs>
                {/* Glow */}
                <path
                  d={`M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="rgba(37, 99, 235, 0.15)"
                  strokeWidth="6"
                  strokeLinecap="round"
                />
                {/* Main line */}
                <path
                  d={`M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="url(#connectorGrad)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                {/* Dots at endpoints */}
                <circle cx={x1} cy={y1} r="3" fill="#2563eb" opacity="0.5" />
                <circle cx={x2} cy={y2} r="3" fill="#2563eb" opacity="0.5" />
              </svg>
            );
          })()}

          {/* ── Connected Session Panel ── */}
          {selectedAgent && (
            <div
              ref={sessionPanelRef}
              style={{
                position: 'fixed',
                left: sessionPanelPos.x,
                top: sessionPanelPos.y,
                width: 380,
                maxHeight: 420,
                zIndex: 9999,
                background: 'rgba(255, 255, 255, 0.18)',
                backdropFilter: 'blur(80px) saturate(2.2)',
                WebkitBackdropFilter: 'blur(80px) saturate(2.2)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: 16,
                boxShadow: '0 24px 80px rgba(0, 0, 0, 0.08), 0 8px 32px rgba(0, 0, 0, 0.04), inset 0 0.5px 0 rgba(255, 255, 255, 0.4), inset 0 -0.5px 0 rgba(255, 255, 255, 0.1)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                animation: 'drillFadeIn 180ms cubic-bezier(0.32, 0.72, 0, 1)',
              }}
            >
              {/* Header — draggable */}
              <div
                onMouseDown={handleSessionDragStart}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 14px 10px',
                  cursor: 'grab',
                  userSelect: 'none',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    width: 20, height: 20, borderRadius: 6,
                    background: 'rgba(37, 99, 235, 0.15)',
                    border: '1px solid rgba(37, 99, 235, 0.25)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700, color: '#2563eb',
                  }}>
                    {selectedAgent[0]}
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
                    {selectedAgent}
                  </span>
                  {agentTotalCost > 0 && (
                    <span style={{
                      fontSize: 11, fontWeight: 700, color: '#22c55e',
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                      background: 'rgba(34, 197, 94, 0.1)',
                      padding: '2px 6px',
                      borderRadius: 6,
                    }}>
                      ${agentTotalCost.toFixed(2)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    onClick={handleOpenIssues}
                    style={{
                      height: 22, borderRadius: 6,
                      border: 'none',
                      background: issuesPanelOpen ? 'rgba(37, 99, 235, 0.2)' : 'rgba(255,255,255,0.12)',
                      color: issuesPanelOpen ? '#2563eb' : 'var(--t-text-muted)',
                      cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '0 8px',
                      fontSize: 10, fontWeight: 600, letterSpacing: '-0.01em',
                      transition: 'all 120ms',
                    }}
                    onMouseEnter={(e) => { if (!issuesPanelOpen) e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
                    onMouseLeave={(e) => { if (!issuesPanelOpen) e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
                  >
                    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
                    </svg>
                    Assign
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedAgent(null)}
                    aria-label="Close"
                    style={{
                      width: 22, height: 22, borderRadius: 11,
                      border: 'none', background: 'rgba(255,255,255,0.12)',
                      color: 'var(--t-text-muted)', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: 600, lineHeight: 1,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
                  >
                    ×
                  </button>
                </div>
              </div>

              {/* Session list */}
              <div style={{
                padding: '10px 14px 14px',
                overflowY: 'auto',
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}>
                {sessionsLoading && (
                  <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 11, padding: 16 }}>
                    Loading sessions…
                  </div>
                )}

                {!sessionsLoading && agentSessions.map((session) => (
                  <div
                    key={session.id}
                    style={{
                      background: session.active
                        ? 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(52,211,153,0.06) 100%)'
                        : 'rgba(255, 255, 255, 0.1)',
                      border: session.active
                        ? '1px solid rgba(52, 211, 153, 0.25)'
                        : '1px solid rgba(255, 255, 255, 0.12)',
                      borderRadius: 10,
                      padding: 10,
                      cursor: 'pointer',
                      transition: 'all 120ms ease',
                      animation: session.active ? 'sessionPulse 3s ease-in-out infinite' : 'none',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.18)';
                      e.currentTarget.style.border = '1px solid rgba(37, 99, 235, 0.2)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                      e.currentTarget.style.border = '1px solid rgba(255, 255, 255, 0.12)';
                    }}
                  >
                    {/* Session label */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
                        {session.label}
                      </span>
                      <div style={{
                        width: 6, height: 6, borderRadius: 3,
                        background: session.status === 'active' ? '#34c759' : '#9ca3af',
                      }} />
                    </div>
                    {/* Meta row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {session.startTime && (
                        <>
                          <span style={{
                            fontSize: 10, color: 'var(--t-text-muted)',
                            fontFamily: '"SF Mono", ui-monospace, monospace',
                          }}>
                            {session.startTime}
                          </span>
                          <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                        </>
                      )}
                      {session.duration && (
                        <>
                          <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontWeight: 600 }}>
                            {session.duration}
                          </span>
                          <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                        </>
                      )}
                      <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>
                        {session.messages} msg{session.messages !== 1 ? 's' : ''}
                      </span>
                      {session.model && (
                        <>
                          <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                          <span style={{ fontSize: 10, color: 'var(--t-text-secondary)' }}>
                            {session.model}
                          </span>
                        </>
                      )}
                    </div>
                    {/* Cost + token row */}
                    {session.cost != null && session.cost > 0 && (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        marginTop: 6, flexWrap: 'wrap',
                      }}>
                        <span style={{
                          fontSize: 11, fontWeight: 700, color: '#22c55e',
                          fontFamily: '"SF Mono", ui-monospace, monospace',
                        }}>
                          ${session.cost.toFixed(3)}
                        </span>
                        {(session.outputTokens ?? 0) > 0 && (
                          <>
                            <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                            <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                              {((session.outputTokens ?? 0) / 1000).toFixed(1)}k out
                            </span>
                          </>
                        )}
                        {(session.cacheTokens ?? 0) > 0 && (
                          <>
                            <span style={{ fontSize: 9, color: 'var(--t-text-faint)' }}>·</span>
                            <span style={{ fontSize: 10, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                              {((session.cacheTokens ?? 0) / 1_000_000).toFixed(1)}M cache
                            </span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                {!sessionsLoading && agentSessions.length === 0 && (
                  <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 11, padding: 16 }}>
                    No sessions found
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── SVG Connector: Session Panel → Issues Panel ── */}
          {issuesPanelOpen && selectedAgent && (() => {
            const x1 = sessionPanelPos.x + 380 + 2;
            const y1 = sessionPanelPos.y + 30;
            const x2 = issuesPanelPos.x;
            const y2 = issuesPanelPos.y + 30;
            const cpOffset = Math.min(80, Math.abs(x2 - x1) * 0.4);
            return (
              <svg style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 9998 }}>
                <defs>
                  <linearGradient id="issueConnGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.6" />
                    <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.3" />
                  </linearGradient>
                </defs>
                <path d={`M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`} fill="none" stroke="rgba(245, 158, 11, 0.15)" strokeWidth="6" strokeLinecap="round" />
                <path d={`M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`} fill="none" stroke="url(#issueConnGrad)" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx={x1} cy={y1} r="3" fill="#f59e0b" opacity="0.5" />
                <circle cx={x2} cy={y2} r="3" fill="#f59e0b" opacity="0.5" />
              </svg>
            );
          })()}

          {/* ── Issues Assignment Panel ── */}
          {issuesPanelOpen && selectedAgent && (
            <div
              ref={issuesPanelRef}
              style={{
                position: 'fixed',
                left: issuesPanelPos.x,
                top: issuesPanelPos.y,
                width: 360,
                maxHeight: 440,
                zIndex: 9999,
                background: 'rgba(255, 255, 255, 0.18)',
                backdropFilter: 'blur(80px) saturate(2.2)',
                WebkitBackdropFilter: 'blur(80px) saturate(2.2)',
                border: '1px solid rgba(245, 158, 11, 0.2)',
                borderRadius: 16,
                boxShadow: '0 24px 80px rgba(0, 0, 0, 0.08), 0 8px 32px rgba(0, 0, 0, 0.04), inset 0 0.5px 0 rgba(255, 255, 255, 0.4)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                animation: 'drillFadeIn 180ms cubic-bezier(0.32, 0.72, 0, 1)',
              }}
            >
              {/* Header */}
              <div
                onMouseDown={handleIssuesDragStart}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 14px 10px', cursor: 'grab', userSelect: 'none',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
                      Assign to {selectedAgent}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                      {resolveAgentRepo(selectedAgent).split('/')[1] ?? 'cortex-ide'}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIssuesPanelOpen(false)}
                  aria-label="Close"
                  style={{
                    width: 22, height: 22, borderRadius: 11,
                    border: 'none', background: 'rgba(255,255,255,0.12)',
                    color: 'var(--t-text-muted)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 600, lineHeight: 1,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
                >
                  ×
                </button>
              </div>

              {/* Issues list */}
              <div style={{
                padding: '8px 14px 14px', overflowY: 'auto', flex: 1,
                display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                {issuesLoading && (
                  <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 11, padding: 16 }}>
                    Loading issues…
                  </div>
                )}

                {!issuesLoading && ghIssues.map((issue) => (
                  <div
                    key={issue.number}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                      background: 'rgba(255, 255, 255, 0.1)',
                      border: '1px solid rgba(255, 255, 255, 0.12)',
                      borderRadius: 10, padding: '8px 10px',
                      transition: 'all 120ms',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.18)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                          #{issue.number}
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {issue.title}
                        </span>
                      </div>
                      {issue.labels.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {issue.labels.slice(0, 3).map((label, li) => {
                            const labelName = typeof label === 'string' ? label : label.name;
                            return (
                            <span key={li} style={{
                              fontSize: 9, padding: '1px 5px', borderRadius: 4,
                              background: 'rgba(255, 255, 255, 0.15)',
                              color: 'var(--t-text-muted)', fontWeight: 500,
                            }}>
                              {labelName}
                            </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleAssignIssue(issue.number)}
                      disabled={assigningIssue === issue.number}
                      style={{
                        height: 24, borderRadius: 6, border: 'none',
                        background: assigningIssue === issue.number ? 'rgba(245, 158, 11, 0.3)' : 'rgba(245, 158, 11, 0.15)',
                        color: '#f59e0b', cursor: assigningIssue === issue.number ? 'wait' : 'pointer',
                        fontSize: 10, fontWeight: 700, padding: '0 8px',
                        flexShrink: 0, transition: 'all 120ms',
                      }}
                      onMouseEnter={(e) => { if (assigningIssue !== issue.number) e.currentTarget.style.background = 'rgba(245, 158, 11, 0.25)'; }}
                      onMouseLeave={(e) => { if (assigningIssue !== issue.number) e.currentTarget.style.background = 'rgba(245, 158, 11, 0.15)'; }}
                    >
                      {assigningIssue === issue.number ? '…' : 'Assign'}
                    </button>
                  </div>
                ))}

                {!issuesLoading && ghIssues.length === 0 && (
                  <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 11, padding: 16 }}>
                    No open issues
                  </div>
                )}
              </div>
            </div>
          )}
        </>,
        document.body,
      )}
    </div>
  );
}
