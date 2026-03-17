'use client';

/**
 * SessionTimeline — Day-level activity bar below the TitleBar.
 *
 * Shows the ENTIRE DAY across all agents. Hover to see a vertical
 * scrubber line with timestamp. Click expand to open the full
 * timeline Canvas tab.
 *
 * Phase 1: Fetches real data from /api/panel/timeline.
 * Falls back to mock data if API is unavailable.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

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

// ── Mock data fallback ──

export function generateMockSegments(): TimelineSegment[] {
  const now = new Date();
  const startOfDay = new Date(now);
  // Rolling 6 AM window — before 6 AM, anchor to yesterday 6 AM (matches API route)
  if (now.getHours() < 6) {
    startOfDay.setDate(startOfDay.getDate() - 1);
  }
  startOfDay.setHours(6, 0, 0, 0);
  const elapsed = Math.max(0, Math.floor((now.getTime() - startOfDay.getTime()) / 60000));
  if (elapsed === 0) return [{ kind: 'idle', startMin: 0, durationMin: 1 }];

  const segs: TimelineSegment[] = [];
  let c = 0;
  const add = (kind: SegmentKind, dur: number, label: string, agent?: string) => {
    const d = Math.min(dur, elapsed - c);
    if (d > 0) { segs.push({ kind, startMin: c, durationMin: d, label, agent }); c += d; }
  };
  add('thinking', 12, 'Boot + context load', 'Mister');
  add('coding', 35, 'NavRail + TitleBar', 'Mister');
  add('thinking', 5, 'Planning', 'Mister');
  add('coding', 45, 'SessionTimeline + Canvas', 'Mister');
  add('testing', 15, 'Tauri verification', 'Mister');
  add('coding', 25, 'Icon fixes + permissions', 'Mister');
  add('error', 3, 'startDragging denied', 'Mister');
  add('coding', 30, 'Timeline expand + colors', 'Mister');
  if (c < elapsed) add('idle', elapsed - c, 'Idle');
  return segs;
}

// ── Data fetching ──

function useTimelineData() {
  const [segments, setSegments] = useState<TimelineSegment[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/timeline');
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
    // Fallback: try cache, then mock
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
    setSegments(generateMockSegments());
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60_000); // refresh every 60s
    return () => clearInterval(interval);
  }, [fetchData]);

  return { segments, loading };
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
  const barRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverMin, setHoverMin] = useState<number | null>(null);

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
  const [drillPos, setDrillPos] = useState({ x: 200, y: 100 });
  const [drillSize, setDrillSize] = useState({ w: 520, h: 400 });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  // ── Connected session panel state ──
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [sessionPanelPos, setSessionPanelPos] = useState({ x: 0, y: 0 });
  const sessionDragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const agentCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const sessionPanelRef = useRef<HTMLDivElement>(null);
  // Force re-render connector line during drags
  const [, forceUpdate] = useState(0);
  const tickDrag = useCallback(() => forceUpdate(n => n + 1), []);

  interface AgentSession { id: string; label: string; model: string; startTime: string; duration: string; messages: number; status: string; cost?: number; inputTokens?: number; outputTokens?: number; cacheTokens?: number }
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [agentTotalCost, setAgentTotalCost] = useState<number>(0);

  const handleBarDoubleClick = useCallback((e: React.MouseEvent) => {
    // Open drill-down centered on click position
    const x = Math.max(20, e.clientX - 260);
    const y = Math.max(60, e.clientY + 10);
    setDrillPos({ x, y });
    setDrillOpen(true);
  }, []);

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
      x: drillPos.x + drillSize.w + 40,
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
          const sessions: AgentSession[] = data.sessions.map((s: { id: string; model: string; messages: number; cost: number; inputTokens: number; outputTokens: number; cacheTokens: number }) => ({
            id: s.id,
            label: s.id.slice(0, 8),
            model: s.model || '',
            startTime: '',
            duration: '',
            messages: s.messages,
            status: 'active',
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

  // Close session panel when drill closes
  useEffect(() => {
    if (!drillOpen) setSelectedAgent(null);
  }, [drillOpen]);

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
  }, [totalRendered, totalSpan, segmentRanges, segments]);

  const handleBarMouseLeave = useCallback(() => {
    setHoverX(null);
    setHoverMin(null);
    setHoveredSegIdx(null);
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
        onDoubleClick={handleBarDoubleClick}
        style={{
          flex: 1,
          height: 18,
          borderRadius: 4,
          overflow: 'visible',
          display: 'flex',
          background: 'var(--t-timeline-bar)',
          position: 'relative',
          cursor: 'crosshair',
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
              {/* Top badge — time */}
              <div style={{
                position: 'absolute',
                left: hoverX,
                bottom: '100%',
                transform: 'translateX(-50%)',
                marginBottom: 8,
                padding: '3px 8px',
                borderRadius: 6,
                background: 'var(--t-text)',
                color: 'var(--t-panel)',
                fontSize: 10,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                zIndex: 10,
                letterSpacing: '0.02em',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              }}>
                {formatTime(hoverMin)}
              </div>
              {/* Bottom badge — segment kind + duration + agent */}
              {seg && (
                <div style={{
                  position: 'absolute',
                  left: hoverX,
                  top: '100%',
                  transform: 'translateX(-50%)',
                  marginTop: 6,
                  padding: '3px 8px',
                  borderRadius: 6,
                  background: badgeBg,
                  color: seg.kind === 'thinking' ? '#1e3a5f' : '#fff',
                  fontSize: 10,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  zIndex: 10,
                  boxShadow: `0 2px 8px ${badgeBg}40`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}>
                  <span>{kindLabel}</span>
                  <span style={{ opacity: 0.7, fontWeight: 500 }}>{durLabel}{agentLabel}</span>
                </div>
              )}
            </>
          );
        })()}

        {/* Time markers — positioned by finding which segment contains each hour mark */}
        {Array.from({ length: Math.ceil(totalSpan / 60) + 1 }, (_, i) => {
          const hourMin = i * 60;
          if (hourMin > totalSpan) return null;
          // Find the pixel position of this hour mark by locating which segment it falls in
          let leftPct = 0;
          let cumDur = 0;
          for (let si = 0; si < segments.length; si++) {
            const seg = segments[si];
            if (hourMin >= seg.startMin && hourMin < seg.startMin + seg.durationMin) {
              // This hour falls within this segment
              const withinSeg = (hourMin - seg.startMin) / seg.durationMin;
              leftPct = ((cumDur + withinSeg * seg.durationMin) / totalRendered) * 100;
              break;
            }
            cumDur += seg.durationMin;
            if (si === segments.length - 1) {
              leftPct = (cumDur / totalRendered) * 100;
            }
          }
          return (
            <div key={i} style={{
              position: 'absolute',
              left: `${leftPct}%`,
              bottom: -14,
              transform: 'translateX(-50%)',
              fontSize: 8,
              color: 'var(--t-text-faint)',
              fontWeight: 500,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}>
              {formatTime(hourMin)}
            </div>
          );
        })}
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
      {drillOpen && typeof document !== 'undefined' && createPortal(
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
              {agentBreakdown.map((entry) => (
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
                  {/* Agent header */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{
                        width: 24, height: 24, borderRadius: 8,
                        background: 'rgba(37, 99, 235, 0.12)',
                        border: '1px solid rgba(37, 99, 235, 0.2)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 700, color: '#2563eb',
                      }}>
                        {entry.agent[0]}
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
                        {entry.agent}
                      </span>
                    </div>
                    <span style={{
                      fontSize: 11, fontWeight: 600, color: 'var(--t-text-muted)',
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                    }}>
                      {formatDuration(entry.totalMin)}
                    </span>
                  </div>

                  {/* Per-agent timeline bar */}
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

                  {/* Breakdown stats */}
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
              ))}

              {agentBreakdown.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 12, padding: 20 }}>
                  No agent activity yet today
                </div>
              )}
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
                      background: 'rgba(255, 255, 255, 0.1)',
                      border: '1px solid rgba(255, 255, 255, 0.12)',
                      borderRadius: 10,
                      padding: 10,
                      cursor: 'pointer',
                      transition: 'all 120ms ease',
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
        </>,
        document.body,
      )}
    </div>
  );
}
