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

export function formatTime(minutesSince9am: number): string {
  const h = 9 + Math.floor(minutesSince9am / 60);
  const m = minutesSince9am % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// ── Mock data fallback ──

export function generateMockSegments(): TimelineSegment[] {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(9, 0, 0, 0);
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
        background: 'rgba(0,0,0,0.06)', color: '#374151',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', transition: 'background 120ms', flexShrink: 0, padding: 0,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.1)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.06)'; }}
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

  const totalMinutes = useMemo(() => {
    if (segments.length === 0) return 0;
    const last = segments[segments.length - 1];
    return last.startMin + last.durationMin;
  }, [segments]);

  const kindTotals = useMemo(() => {
    const totals: Partial<Record<SegmentKind, number>> = {};
    for (const seg of segments) {
      totals[seg.kind] = (totals[seg.kind] || 0) + seg.durationMin;
    }
    return totals;
  }, [segments]);

  // Find which segment the cursor is over
  const hoveredSegment = useMemo(() => {
    if (hoverMin === null) return null;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (hoverMin >= seg.startMin && hoverMin < seg.startMin + seg.durationMin) return i;
    }
    return null;
  }, [hoverMin, segments]);

  const handleBarMouseMove = useCallback((e: React.MouseEvent) => {
    if (!barRef.current || totalMinutes === 0) return;
    const rect = barRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    setHoverX(x);
    setHoverMin(Math.round(pct * totalMinutes));
  }, [totalMinutes]);

  const handleBarMouseLeave = useCallback(() => {
    setHoverX(null);
    setHoverMin(null);
  }, []);

  if (loading || totalMinutes === 0) return null;

  return (
    <div style={{
      height: 36,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px 0 90px',
      gap: 12,
      background: 'rgba(248, 250, 252, 0.85)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      borderBottom: '1px solid rgba(0, 0, 0, 0.04)',
      fontSize: 11,
      fontWeight: 500,
      color: '#6b7280',
      letterSpacing: '-0.01em',
    }}>
      {/* Left — Play + Expand + Label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, whiteSpace: 'nowrap' }}>
        <TimelineButton icon={<PlayIcon />} label="Play session replay" />
        {onExpand && <TimelineButton icon={<ExpandIcon />} label="Expand timeline" onClick={onExpand} />}
        <span style={{ fontWeight: 600, color: '#374151', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em' }}>
          Today: {formatDuration(totalMinutes)}
        </span>
      </div>

      {/* Center — Segmented bar with hover scrubber */}
      <div
        ref={barRef}
        onMouseMove={handleBarMouseMove}
        onMouseLeave={handleBarMouseLeave}
        style={{
          flex: 1,
          height: 18,
          borderRadius: 4,
          overflow: 'visible',
          display: 'flex',
          background: '#f1f5f9',
          position: 'relative',
          cursor: 'crosshair',
        }}
      >
        {/* Segments */}
        {segments.map((seg, i) => {
          const widthPct = (seg.durationMin / totalMinutes) * 100;
          const isHovered = hoveredSegment === i;
          return (
            <div
              key={i}
              style={{
                width: `${widthPct}%`,
                height: '100%',
                background: SEGMENT_COLORS[seg.kind],
                opacity: isHovered ? 1 : 0.8,
                transition: 'opacity 80ms',
                borderRight: i < segments.length - 1 ? '1px solid rgba(255,255,255,0.25)' : 'none',
                borderRadius: i === 0 ? '4px 0 0 4px' : i === segments.length - 1 ? '0 4px 4px 0' : 0,
              }}
            />
          );
        })}

        {/* Hover scrubber line + timestamp */}
        {hoverX !== null && hoverMin !== null && (
          <>
            {/* Vertical line */}
            <div style={{
              position: 'absolute',
              left: hoverX,
              top: -4,
              bottom: -4,
              width: 1.5,
              background: '#111827',
              borderRadius: 1,
              pointerEvents: 'none',
              zIndex: 5,
            }} />
            {/* Timestamp badge above */}
            <div style={{
              position: 'absolute',
              left: hoverX,
              bottom: '100%',
              transform: 'translateX(-50%)',
              marginBottom: 6,
              padding: '2px 7px',
              borderRadius: 5,
              background: '#111827',
              color: '#fff',
              fontSize: 9,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 10,
              letterSpacing: '0.02em',
            }}>
              {formatTime(hoverMin)}
            </div>
            {/* Segment label below */}
            {hoveredSegment !== null && (
              <div style={{
                position: 'absolute',
                left: hoverX,
                top: '100%',
                transform: 'translateX(-50%)',
                marginTop: 4,
                padding: '2px 7px',
                borderRadius: 5,
                background: SEGMENT_COLORS[segments[hoveredSegment].kind],
                color: '#fff',
                fontSize: 9,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                zIndex: 10,
              }}>
                {segments[hoveredSegment].label || SEGMENT_LABELS[segments[hoveredSegment].kind]}
              </div>
            )}
          </>
        )}

        {/* Time markers */}
        {Array.from({ length: Math.ceil(totalMinutes / 60) + 1 }, (_, i) => {
          const min = i * 60;
          if (min > totalMinutes) return null;
          const leftPct = (min / totalMinutes) * 100;
          return (
            <div key={i} style={{
              position: 'absolute',
              left: `${leftPct}%`,
              bottom: -14,
              transform: 'translateX(-50%)',
              fontSize: 8,
              color: '#b0b8c4',
              fontWeight: 500,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}>
              {formatTime(min)}
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
              <span style={{ fontSize: 10, color: '#9ca3af' }}>{formatDuration(total)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
