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

import { lazy, Suspense, useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { fetchOnce } from '@/lib/panel/fetch-cache';
import type { AgentSummary } from '@/lib/fleet/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
const CortexTaskBoard = lazy(() => import('./CortexTaskBoard').then(m => ({ default: m.CortexTaskBoard })));
import type { FirstMergeCelebrationState } from '@/lib/ftux/first-merge';

// ── Types ──

export type SegmentKind = 'thinking' | 'coding' | 'testing' | 'error' | 'idle';

export interface TimelineSegment {
  kind: SegmentKind;
  startMin: number;
  durationMin: number;
  label?: string;
  agent?: string;
}

interface TimelineSegmentGeometry {
  index: number;
  seg: TimelineSegment;
  leftPct: number;
  widthPct: number;
  actualLeftPx: number;
  actualWidthPx: number;
  displayLeftPx: number;
  displayWidthPx: number;
  color: string;
  layer: number;
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
const TIMELINE_BAR_HEIGHT = 20;
const TIMELINE_ACTIVE_SEGMENT_MIN_PX = 20;
const TIMELINE_THINKING_MIN_PX = 20;
const TIMELINE_TESTING_MIN_PX = 20;
// Keep the drill-down implementation in place, but disable dashboard
// double-click entry until the interaction is ready to ship.
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

function timelineSegmentLayer(kind: SegmentKind) {
  switch (kind) {
    case 'coding': return 1;
    case 'thinking': return 2;
    case 'testing': return 3;
    case 'error': return 4;
    default: return 0;
  }
}

function timelineSegmentMinWidth(kind: SegmentKind) {
  if (kind === 'error') return 7;
  if (kind === 'thinking') return TIMELINE_THINKING_MIN_PX;
  if (kind === 'testing') return TIMELINE_TESTING_MIN_PX;
  return TIMELINE_ACTIVE_SEGMENT_MIN_PX;
}

function timelineSegmentDisplayWidth(kind: SegmentKind, actualWidthPx: number) {
  const minWidthPx = timelineSegmentMinWidth(kind);
  if (actualWidthPx <= minWidthPx) return minWidthPx;
  if (kind === 'coding' && actualWidthPx < 9) return 9;
  if (kind === 'thinking' && actualWidthPx < 12) return 12;
  if (kind === 'testing' && actualWidthPx < 10) return 10;
  if (kind === 'error' && actualWidthPx < 8) return 8;
  return actualWidthPx;
}

function timelineSegmentChrome(_kind: SegmentKind, color: string, hovered: boolean) {
  // Watercolor: uniform height, wide feathered edges, no hard boundaries
  return {
    top: 2,
    height: TIMELINE_BAR_HEIGHT - 4,
    borderRadius: 999,
    opacity: hovered ? 0.95 : 0.7,
    background: `linear-gradient(90deg, ${color}00 0%, ${color}90 20%, ${color} 40%, ${color} 60%, ${color}90 80%, ${color}00 100%)`,
    boxShadow: 'none',
    transform: 'none',
  };
}

function runtimeLabel(runtime: string | null | undefined): string {
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
    .replace(/^Recent automation surface; useful for visibility, not the primary operator lane\.?\s*/i, '')
    .replace(/^Mirroring the live Q ↔ Mister conversation, not spawning a fresh session\.?\s*/i, '')
    .trim();
}

function humanizeStatus(status: string | null | undefined): string {
  if (!status) return 'Idle';
  if (status === 'reviewing') return 'Reviewing';
  if (status === 'running') return 'Running';
  if (status === 'waiting') return 'Waiting';
  if (status === 'blocked') return 'Blocked';
  if (status === 'failed') return 'Failed';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function timelineMatchesAgent(agentName: string, session: AgentSummary): boolean {
  const key = session.sessionKey.toLowerCase();
  const name = (session.name || '').toLowerCase();
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
  const [windowMinutes, setWindowMinutes] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/timeline');
      if (res.ok) {
        const data = await res.json();
        setWindowMinutes(data.windowMinutes ?? 0);
        if (data.segments?.length > 0) {
          setSegments(data.segments);
          // Cache in sessionStorage
          try {
            sessionStorage.setItem('cortex-timeline', JSON.stringify({
              ts: Date.now(),
              segments: data.segments,
              windowMinutes: data.windowMinutes ?? 0,
            }));
          } catch {}
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
          setWindowMinutes(parsed.windowMinutes ?? 0);
          setLoading(false);
          return;
        }
      }
    } catch {}
    setSegments([]);
    setWindowMinutes(0);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    // WS-driven: instant refresh on agent events instead of 60s polling
    const handler = () => { fetchData(); };
    const wsEvents = ['o8:agent-lifecycle', 'o8:lane-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchData, 300_000);
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [fetchData]);

  return { segments, windowMinutes, loading };
}

function useTimelineSessions() {
  const [sessions, setSessions] = useState<AgentSummary[]>([]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetchOnce('/api/mobile/inbox');
      if (!res.ok) return;
      const data = await res.json() as MobileInboxSnapshot;
      setSessions(data.sessions ?? []);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
    // WS-driven: instant refresh on inbox/agent events instead of 30s polling
    const handler = () => { void fetchSessions(); };
    const wsEvents = ['o8:inbox', 'o8:agent-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchSessions, 300_000);
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
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
        width: 24,
        height: 24,
        borderRadius: 12,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel-hover)',
        color: 'var(--t-text)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        transition: 'background 140ms ease, border-color 140ms ease, transform 140ms ease',
        flexShrink: 0,
        padding: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--t-accent-soft)';
        e.currentTarget.style.borderColor = 'var(--t-accent-border)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--t-panel-hover)';
        e.currentTarget.style.borderColor = 'var(--t-panel-border)';
        e.currentTarget.style.transform = 'none';
      }}
    >
      {icon}
    </button>
  );
}

function TimelineEmptyState({
  onExpand,
  repoName,
}: {
  onExpand?: () => void;
  repoName?: string | null;
}) {
  const previewSegments = [
    { left: 2, width: 10, opacity: 0.42, height: 5, tone: 'neutral' },
    { left: 14, width: 18, opacity: 0.14, height: 8, tone: 'accent' },
    { left: 35, width: 8, opacity: 0.24, height: 6, tone: 'neutral' },
    { left: 46, width: 20, opacity: 0.11, height: 10, tone: 'accent' },
    { left: 69, width: 12, opacity: 0.3, height: 6, tone: 'neutral' },
    { left: 84, width: 11, opacity: 0.16, height: 7, tone: 'accent' },
  ] as const;

  return (
    <motion.div
      key="timeline-empty"
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 8,
        paddingRight: 16,
        paddingBottom: 10,
        paddingLeft: 90,
        background: 'transparent',
        borderBottom: '1px solid var(--t-divider-subtle)',
        color: 'var(--t-text)',
        fontFamily: 'system-ui, sans-serif',
        letterSpacing: '-0.01em',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: 44,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
          minWidth: 0,
        }}>
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--t-text-faint)',
            whiteSpace: 'nowrap',
          }}>
            Waiting for activity
          </span>
        </div>
        <div style={{
          minWidth: 0,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
            lineHeight: 1.25,
          }}>
            {repoName ? `${repoName} activity will appear here once agents are active.` : 'Commits, PRs, and CI runs will appear here once agents are active.'}
          </div>
          <div style={{
            fontSize: 11,
            lineHeight: 1.35,
            color: 'var(--t-text-faint)',
            letterSpacing: '-0.01em',
          }}>
            This rail fills in as work starts, then fades back to the live timeline without a jump.
          </div>
        </div>
        {onExpand ? (
          <button
            type="button"
            onClick={onExpand}
            aria-label="Open timeline"
            style={{
              minHeight: 44,
              paddingTop: 0,
              paddingRight: 14,
              paddingBottom: 0,
              paddingLeft: 14,
              borderRadius: 12,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-panel-translucent)',
              color: 'var(--t-text)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              cursor: 'pointer',
              fontFamily: 'system-ui, sans-serif',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              flexShrink: 0,
              transition: 'background 140ms ease, border-color 140ms ease, transform 140ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--t-accent-soft)';
              e.currentTarget.style.borderColor = 'var(--t-accent-border)';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--t-panel-translucent)';
              e.currentTarget.style.borderColor = 'var(--t-panel-border)';
              e.currentTarget.style.transform = 'none';
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--t-text-secondary)' }}>
              <ExpandIcon />
            </span>
            Open timeline
          </button>
        ) : null}
      </div>

      <div style={{
        position: 'relative',
        height: 18,
        borderRadius: 14,
        border: '1px solid var(--t-divider-subtle)',
        background: 'linear-gradient(180deg, var(--t-panel-translucent) 0%, var(--t-bg-card) 100%)',
        overflow: 'hidden',
        boxShadow: 'inset 0 0 0 1px var(--t-divider-subtle)',
      }}>
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--t-divider-subtle)',
          opacity: 0.38,
        }} />
        <div style={{
          position: 'absolute',
          inset: '3px 8px',
          pointerEvents: 'none',
        }}>
          {previewSegments.map((segment, index) => (
            <div
              key={`${segment.left}-${index}`}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: `${segment.left}%`,
                width: `${segment.width}%`,
                top: `calc((100% - ${segment.height}px) / 2)`,
                height: segment.height,
                borderRadius: 999,
                background: segment.tone === 'accent' ? 'var(--t-accent)' : 'var(--t-text-secondary)',
                opacity: segment.opacity,
                filter: 'blur(0.1px)',
              }}
            />
          ))}
          <div style={{
            position: 'absolute',
            left: '62%',
            top: 0,
            bottom: 0,
            width: 1,
            background: 'var(--t-accent)',
            opacity: 0.14,
            borderRadius: 999,
          }} />
        </div>
      </div>
    </motion.div>
  );
}

// ── Component ──

export function SessionTimeline({
  onExpand,
  repoPath,
  repoName,
  firstMergeCelebration,
}: {
  onExpand?: () => void;
  repoPath?: string | null;
  repoName?: string | null;
  firstMergeCelebration?: FirstMergeCelebrationState | null;
}) {
  const { segments, windowMinutes, loading } = useTimelineData();
  const liveSessions = useTimelineSessions();
  const barRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverMin, setHoverMin] = useState<number | null>(null);
  const [hoverClientX, setHoverClientX] = useState<number | null>(null);
  const [hoverBarTop, setHoverBarTop] = useState<number>(0);
  const celebrationWash = (
    <AnimatePresence>
      {firstMergeCelebration ? (
        <motion.div
          initial={{ opacity: 0, scaleX: 0.08 }}
          animate={{ opacity: 0.96, scaleX: 1 }}
          exit={{ opacity: 0, scaleX: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 6,
            overflow: 'hidden',
            transformOrigin: 'left center',
            background: 'var(--t-celebration-wash)',
            boxShadow: 'inset 0 0 0 1px var(--t-celebration-border), 0 0 24px var(--t-celebration-glow)',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          <motion.div
            initial={{ x: '-38%' }}
            animate={{ x: '42%' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 3.1, ease: 'easeInOut' }}
            style={{
              position: 'absolute',
              inset: '-20% auto -20% -12%',
              width: '42%',
              background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.14) 48%, transparent 100%)',
              filter: 'blur(8px)',
            }}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  const fallbackWindowMinutes = useMemo(() => {
    const now = new Date();
    const anchor = new Date(now);
    if (now.getHours() < 6) {
      anchor.setDate(anchor.getDate() - 1);
    }
    anchor.setHours(6, 0, 0, 0);
    return Math.max(1, Math.floor((now.getTime() - anchor.getTime()) / 60000));
  }, []);
  const totalSpan = windowMinutes > 0 ? windowMinutes : fallbackWindowMinutes;
  const hasActivity = segments.length > 0;

  const kindTotals = useMemo(() => {
    const totals: Partial<Record<SegmentKind, number>> = {};
    for (const seg of segments) {
      totals[seg.kind] = (totals[seg.kind] || 0) + seg.durationMin;
    }
    return totals;
  }, [segments]);

  const [hoveredSegIdx, setHoveredSegIdx] = useState<number | null>(null);

  const segmentGeometry = useMemo(() => {
    if (totalSpan === 0) return [] as TimelineSegmentGeometry[];
    return segments.reduce<TimelineSegmentGeometry[]>((acc, seg, index) => {
      if (seg.kind === 'idle') return acc;
      const leftPct = (seg.startMin / totalSpan) * 100;
      const widthPct = (seg.durationMin / totalSpan) * 100;
      const actualWidthPx = barWidth > 0 ? (seg.durationMin / totalSpan) * barWidth : 0;
      const actualLeftPx = barWidth > 0 ? (seg.startMin / totalSpan) * barWidth : 0;
      const displayWidthPx = barWidth > 0 ? timelineSegmentDisplayWidth(seg.kind, actualWidthPx) : 0;
      const centeredLeftPx = actualLeftPx + (actualWidthPx / 2) - (displayWidthPx / 2);
      const displayLeftPx = barWidth > 0
        ? Math.min(Math.max(0, centeredLeftPx), Math.max(0, barWidth - displayWidthPx))
        : 0;
      acc.push({
        index,
        seg,
        leftPct,
        widthPct,
        actualLeftPx,
        actualWidthPx,
        displayLeftPx,
        displayWidthPx,
        color: SEGMENT_COLORS[seg.kind],
        layer: timelineSegmentLayer(seg.kind),
      });
      return acc;
    }, []);
  }, [barWidth, segments, totalSpan]);

  const paintedSegments = useMemo(() => {
    return [...segmentGeometry].sort((a, b) => {
      const layerDelta = a.layer - b.layer;
      if (layerDelta !== 0) return layerDelta;
      return a.index - b.index;
    });
  }, [segmentGeometry]);

  const activityWindows = useMemo(() => {
    if (barWidth <= 0 || segmentGeometry.length === 0) return [];

    return [...segmentGeometry]
      .sort((a, b) => a.displayLeftPx - b.displayLeftPx)
      .reduce<Array<{ left: number; width: number }>>((acc, entry) => {
        const left = entry.displayLeftPx;
        const right = entry.displayLeftPx + entry.displayWidthPx;
        const current = acc[acc.length - 1];

        if (!current) {
          acc.push({ left, width: right - left });
          return acc;
        }

        const currentRight = current.left + current.width;
        if (left <= currentRight + 1) {
          current.width = Math.max(current.width, right - current.left);
          return acc;
        }

        acc.push({ left, width: right - left });
        return acc;
      }, []);
  }, [barWidth, segmentGeometry]);

  const hoverSegments = useMemo(() => {
    return [...paintedSegments].sort((a, b) => {
      const layerDelta = b.layer - a.layer;
      if (layerDelta !== 0) return layerDelta;
      const widthDelta = a.displayWidthPx - b.displayWidthPx;
      if (widthDelta !== 0) return widthDelta;
      return b.index - a.index;
    });
  }, [paintedSegments]);

  const ribbonBridges = useMemo(() => {
    if (barWidth <= 0 || totalSpan === 0) return [];
    const bridges: Array<{ key: string; left: number; width: number; color: string; fromIndex: number; toIndex: number }> = [];

    for (let index = 0; index < segments.length - 2; index += 1) {
      const current = segments[index];
      const gap = segments[index + 1];
      const next = segments[index + 2];
      if (!current || !gap || !next) continue;
      if (current.kind === 'idle' || gap.kind !== 'idle' || next.kind !== current.kind || next.kind === 'error') continue;

      const gapWidthPx = (gap.durationMin / totalSpan) * barWidth;
      if (gap.durationMin > 5 || gapWidthPx > 22) continue;

      const left = ((current.startMin + current.durationMin) / totalSpan) * barWidth;
      const right = (next.startMin / totalSpan) * barWidth;
      if (right <= left) continue;

      bridges.push({
        key: `${index}:${index + 2}`,
        left,
        width: right - left,
        color: SEGMENT_COLORS[current.kind],
        fromIndex: index,
        toIndex: index + 2,
      });
    }

    return bridges;
  }, [barWidth, segments, totalSpan]);

  useEffect(() => {
    const node = barRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const update = () => {
      setBarWidth(node.getBoundingClientRect().width);
    };

    update();
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      setBarWidth(typeof nextWidth === 'number' ? nextWidth : node.getBoundingClientRect().width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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
    setSelectedAgent(null);
    setIssuesPanelOpen(false);
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

  const hoveredSeg = hoveredSegIdx !== null ? segments[hoveredSegIdx] ?? null : null;
  const hoveredContext = hoveredSeg?.agent ? liveAgentContext.get(hoveredSeg.agent) ?? null : null;

  const hoverCard = useMemo(() => {
    if (hoverMin === null) return null;
    const isIdle = hoveredSeg?.kind === 'idle';

    const startMin = hoveredSeg ? hoveredSeg.startMin : hoverMin;
    const endMin = hoveredSeg ? Math.min(totalSpan, hoveredSeg.startMin + hoveredSeg.durationMin) : hoverMin;
    const rangeLabel = hoveredSeg
      ? `${formatTime(startMin)} - ${formatTime(endMin)}`
      : formatTime(hoverMin);
    const durationLabel = hoveredSeg ? formatDuration(hoveredSeg.durationMin) : null;
    const kindLabel = hoveredSeg ? SEGMENT_LABELS[hoveredSeg.kind] : 'IDLE';
    const kindColor = hoveredSeg ? SEGMENT_COLORS[hoveredSeg.kind] : '#94a3b8';

    return {
      rangeLabel,
      durationLabel,
      kindLabel,
      kindColor,
      laneLabel: isIdle
        ? `${hoveredSeg?.agent || 'Timeline'} quiet window`
        : hoveredContext?.label || hoveredSeg?.agent || 'Active lane',
      runtimeLabel: isIdle ? null : hoveredContext?.runtime ?? null,
      statusLabel: isIdle ? null : hoveredContext?.status ? humanizeStatus(hoveredContext.status) : null,
      locationLabel: isIdle ? null : hoveredContext?.location || hoveredSeg?.agent || null,
      summaryLabel: isIdle ? null : hoveredContext?.summary || null,
    };
  }, [hoverMin, hoveredSeg, hoveredContext, totalSpan]);

  const handleBarMouseMove = useCallback((e: React.MouseEvent) => {
    if (!barRef.current || totalSpan === 0 || !hasActivity) return;
    const rect = barRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));

    // Match hover against the rendered geometry, not the raw duration span.
    // That keeps hover aligned with minimum-width visible blocks and ribbons.
    let foundIdx: number | null = null;
    let foundLeftPx = 0;
    let foundWidthPx = 0;

    for (const entry of hoverSegments) {
      const leftPx = barWidth > 0 ? entry.displayLeftPx : rect.width * (entry.leftPct / 100);
      const widthPx = barWidth > 0 ? entry.displayWidthPx : rect.width * (entry.widthPct / 100);
      if (x >= leftPx && x <= leftPx + widthPx) {
        foundIdx = entry.index;
        foundLeftPx = leftPx;
        foundWidthPx = Math.max(widthPx, 1);
        break;
      }
    }

    if (foundIdx === null) {
      for (const bridge of ribbonBridges) {
        if (x >= bridge.left && x <= bridge.left + bridge.width) {
          const midpoint = bridge.left + (bridge.width / 2);
          foundIdx = x <= midpoint ? bridge.fromIndex : bridge.toIndex;
          break;
        }
      }
    }

    // Compute the actual time from the segment's real startMin,
    // but interpolate over the displayed width so the cursor feels aligned.
    let min: number;
    if (foundIdx !== null) {
      const seg = segments[foundIdx];
      if (foundWidthPx > 0) {
        const withinPct = Math.max(0, Math.min(1, (x - foundLeftPx) / foundWidthPx));
        min = Math.round(seg.startMin + withinPct * seg.durationMin);
      } else {
        min = Math.round(pct * totalSpan);
      }
    } else {
      // Fallback: linear interpolation across total span
      min = Math.round(pct * totalSpan);
    }

    setHoverX(x);
    setHoverMin(min);
    setHoveredSegIdx(foundIdx);
    setHoverClientX(e.clientX);
    setHoverBarTop(rect.top);
  }, [barWidth, hasActivity, hoverSegments, ribbonBridges, segments, totalSpan]);

  const handleBarMouseLeave = useCallback(() => {
    setHoverX(null);
    setHoverMin(null);
    setHoveredSegIdx(null);
    setHoverClientX(null);
  }, []);

  if (loading) {
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {onExpand ? <TimelineButton icon={<ExpandIcon />} label="Expand timeline" onClick={onExpand} /> : null}
          <span style={{ fontWeight: 600, color: 'var(--t-text)', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em' }}>
            Today
          </span>
        </div>
        <div style={{
          flex: 1,
          height: TIMELINE_BAR_HEIGHT,
          borderRadius: 6,
          background: 'var(--t-timeline-bar)',
          boxShadow: 'inset 0 0 0 1px rgba(148, 163, 184, 0.08)',
          position: 'relative',
          overflow: 'hidden',
        }}>
          {celebrationWash}
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.14) 50%, transparent 100%)',
            animation: 'llmShimmer 1.6s linear infinite',
          }} />
        </div>
        <div style={{ flexShrink: 0, fontSize: 10, color: 'var(--t-text-faint)' }}>
          Loading activity…
        </div>
      </div>
    );
  }

  return (
    <AnimatePresence initial={false} mode="wait">
      {hasActivity ? (
    <motion.div
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      style={{
      height: 32,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px 0 90px',
      gap: 12,
      background: 'transparent',
      borderBottom: '0.5px solid rgba(0, 0, 0, 0.04)',
      fontSize: 11,
      fontWeight: 500,
      color: 'var(--t-text-secondary)',
      letterSpacing: '-0.01em',
      position: 'relative',
      zIndex: 100,
    }}>
      {/* Left — Play + Expand + Label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap' }}>
        {hasActivity ? <TimelineButton icon={<PlayIcon />} label="Play session replay" /> : null}
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
          height: TIMELINE_BAR_HEIGHT,
          borderRadius: 6,
          overflow: 'visible',
          background: 'var(--t-timeline-bar)',
          position: 'relative',
          cursor: TIMELINE_DRILLDOWN_ENABLED && hasActivity ? 'crosshair' : 'default',
          boxShadow: 'inset 0 0 0 1px rgba(148, 163, 184, 0.08)',
        }}
      >
        {celebrationWash}
        {/* System-wide occupancy backbone — keeps concurrent IDE activity reading as full-width time coverage */}
        {activityWindows.map((window, index) => (
          <div
            key={`activity:${index}:${window.left}:${window.width}`}
            style={{
              position: 'absolute',
              left: window.left,
              width: window.width,
              top: 1,
              height: TIMELINE_BAR_HEIGHT - 2,
              borderRadius: 6,
              background: 'linear-gradient(180deg, var(--t-accent-soft-strong) 0%, var(--t-accent-soft) 100%)',
              boxShadow: 'inset 0 0 0 1px var(--t-accent-ring), inset 0 1px 0 var(--t-divider-subtle)',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        ))}

        {/* Gentle ribbons connecting nearby same-kind runs across tiny idle gaps */}
        {ribbonBridges.map((bridge) => (
          <div
            key={bridge.key}
            style={{
              position: 'absolute',
              left: bridge.left,
              width: bridge.width,
              top: 5,
              height: TIMELINE_BAR_HEIGHT - 10,
              borderRadius: 999,
              background: `linear-gradient(90deg, ${bridge.color}08 0%, ${bridge.color}2d 50%, ${bridge.color}08 100%)`,
              boxShadow: `0 0 12px ${bridge.color}18`,
              pointerEvents: 'none',
              zIndex: 2,
            }}
          />
        ))}

        {/* Segments */}
        {paintedSegments.map((entry) => {
          const isHovered = hoveredSegIdx === entry.index;
          const chrome = timelineSegmentChrome(entry.seg.kind, entry.color, isHovered);
          return (
            <div
              key={entry.index}
              style={{
                position: 'absolute',
                left: barWidth > 0 ? Math.max(0, entry.displayLeftPx - 4) : `${entry.leftPct}%`,
                width: barWidth > 0 ? entry.displayWidthPx + 8 : `${entry.widthPct}%`,
                top: chrome.top,
                height: chrome.height,
                background: chrome.background,
                opacity: chrome.opacity,
                transition: 'opacity 120ms ease-out',
                borderRadius: chrome.borderRadius,
                boxShadow: 'none',
                transform: chrome.transform,
                zIndex: isHovered ? 8 : entry.layer + 3,
              }}
            />
          );
        })}

        {/* Hover scrubber line */}
        {hoverX !== null && hoverMin !== null && (() => {
          const lineColor = hoveredSeg ? SEGMENT_COLORS[hoveredSeg.kind] : 'var(--t-text)';

          return (
            <div style={{
              position: 'absolute',
              left: hoverX,
              top: -6,
              bottom: -6,
              width: 2,
              background: lineColor,
              borderRadius: 1,
              pointerEvents: 'none',
              zIndex: 10,
              boxShadow: `0 0 6px ${lineColor}40`,
            }} />
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

      {hoverCard && hoverClientX !== null && typeof document !== 'undefined' && createPortal(
        <div
            style={{
              position: 'fixed',
              left: Math.min(
                Math.max(12, hoverClientX - 148),
                (typeof window !== 'undefined' ? window.innerWidth : 320) - 308,
            ),
            top: hoverBarTop + TIMELINE_BAR_HEIGHT + 12,
            width: 296,
            padding: '12px 12px 11px',
            borderRadius: 16,
            background: 'var(--t-chrome)',
            backdropFilter: 'blur(24px) saturate(1.45)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.45)',
            border: '1px solid var(--t-panel-border)',
            boxShadow: 'var(--t-panel-shadow), inset 0 1px 0 var(--t-divider-subtle)',
            pointerEvents: 'none',
            zIndex: 10020,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '3px 8px',
                borderRadius: 999,
                background: `${hoverCard.kindColor}18`,
                color: hoverCard.kindColor,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: hoverCard.kindColor }} />
                {hoverCard.kindLabel}
              </span>
              {hoverCard.statusLabel ? (
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)', whiteSpace: 'nowrap' }}>
                  {hoverCard.statusLabel}
                </span>
              ) : null}
            </div>
            {hoverCard.durationLabel ? (
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--t-text)', whiteSpace: 'nowrap' }}>
                {hoverCard.durationLabel}
              </span>
            ) : null}
          </div>

          <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
            {hoverCard.rangeLabel}
          </div>

          <div style={{ marginTop: 5, fontSize: 12, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
            {hoverCard.laneLabel}
          </div>

          {(hoverCard.runtimeLabel || hoverCard.locationLabel) ? (
            <div style={{ marginTop: 3, fontSize: 11, color: 'var(--t-text-secondary)', lineHeight: 1.35 }}>
              {[hoverCard.runtimeLabel, hoverCard.locationLabel].filter(Boolean).join(' · ')}
            </div>
          ) : null}

          {hoverCard.summaryLabel && hoveredSeg ? (
            <div style={{
              marginTop: 7,
              fontSize: 11,
              color: 'var(--t-text-secondary)',
              lineHeight: 1.4,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {hoverCard.summaryLabel}
            </div>
          ) : null}

        </div>,
        document.body,
      )}

      {/* ── Full-Screen Timeline Drilldown / Cortex Board ── */}
      {TIMELINE_DRILLDOWN_ENABLED && drillOpen && typeof document !== 'undefined' && createPortal(
        <>
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.14), rgba(239,246,255,0.1))',
          backdropFilter: 'blur(28px) saturate(1.42)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.42)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'drillFadeIn 180ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}>
            {/* Header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '18px 22px 14px',
                userSelect: 'none',
                borderBottom: '1px solid rgba(255, 255, 255, 0.18)',
                background: 'linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.04))',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
                  Cortex Board
                </span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontWeight: 500 }}>
                  Timeline drilldown · {formatDuration(totalSpan)}
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

            {/* Content — Cortex board shell */}
            <div style={{
              padding: '18px 22px 22px',
              overflow: 'hidden',
              flex: 1,
              minHeight: 0,
            }}>
              <Suspense fallback={null}>
                <CortexTaskBoard
                  repoPath={repoPath}
                  repoName={repoName}
                />
              </Suspense>
            </div>
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
    </motion.div>
      ) : (
        <TimelineEmptyState onExpand={onExpand} repoName={repoName} />
      )}
    </AnimatePresence>
  );
}
