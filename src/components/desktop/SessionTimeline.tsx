'use client';

/**
 * SessionTimeline — Horizontal session replay bar below the TitleBar.
 *
 * V0: Static visualization showing agent activity segments across the day.
 * Future: Interactive scrubber, clickable segments → workspace navigation,
 * live updating as agents work.
 *
 * Layout:
 * Left: "SESSION REPLAY: Xh Xm" label + play button
 * Center: Segmented activity bar (thinking/coding/testing/errors/idle)
 * Right: Current time / total time
 * Bottom: Legend with colored dots
 */

import { useState, useMemo, useCallback } from 'react';

// ── Types ──

type SegmentKind = 'thinking' | 'coding' | 'testing' | 'error' | 'idle';

interface TimelineSegment {
  kind: SegmentKind;
  startMin: number;
  durationMin: number;
  label?: string;
}

// ── Constants ──

const SEGMENT_COLORS: Record<SegmentKind, string> = {
  coding: '#2563eb',    // royal blue
  thinking: '#93c5fd',  // light blue
  testing: '#f59e0b',   // amber
  error: '#ef4444',     // red
  idle: '#e5e7eb',      // light gray
};

const SEGMENT_LABELS: Record<SegmentKind, string> = {
  thinking: 'THINKING',
  coding: 'CODING',
  testing: 'TESTING',
  error: 'ERRORS',
  idle: 'IDLE',
};

// ── Mock data (V0 — will be replaced with real agent activity) ──

function generateMockSegments(): TimelineSegment[] {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(9, 0, 0, 0); // 9 AM start

  const elapsed = Math.max(0, Math.floor((now.getTime() - startOfDay.getTime()) / 60000));
  if (elapsed === 0) return [{ kind: 'idle', startMin: 0, durationMin: 1 }];

  // Generate plausible segments
  const segments: TimelineSegment[] = [];
  let cursor = 0;

  // Morning boot — thinking
  const thinkDur = Math.min(12, elapsed);
  segments.push({ kind: 'thinking', startMin: cursor, durationMin: thinkDur, label: 'Boot + context load' });
  cursor += thinkDur;
  if (cursor >= elapsed) return segments;

  // First coding block
  const code1 = Math.min(35, elapsed - cursor);
  segments.push({ kind: 'coding', startMin: cursor, durationMin: code1, label: 'Feature work' });
  cursor += code1;
  if (cursor >= elapsed) return segments;

  // Short thinking
  const think2 = Math.min(5, elapsed - cursor);
  segments.push({ kind: 'thinking', startMin: cursor, durationMin: think2, label: 'Planning' });
  cursor += think2;
  if (cursor >= elapsed) return segments;

  // Second coding block
  const code2 = Math.min(45, elapsed - cursor);
  segments.push({ kind: 'coding', startMin: cursor, durationMin: code2, label: 'Iteration' });
  cursor += code2;
  if (cursor >= elapsed) return segments;

  // Testing
  const test1 = Math.min(15, elapsed - cursor);
  segments.push({ kind: 'testing', startMin: cursor, durationMin: test1, label: 'Verification' });
  cursor += test1;
  if (cursor >= elapsed) return segments;

  // More coding
  const code3 = Math.min(25, elapsed - cursor);
  segments.push({ kind: 'coding', startMin: cursor, durationMin: code3, label: 'Fixes' });
  cursor += code3;
  if (cursor >= elapsed) return segments;

  // Error
  const err = Math.min(3, elapsed - cursor);
  segments.push({ kind: 'error', startMin: cursor, durationMin: err, label: 'Build errors' });
  cursor += err;
  if (cursor >= elapsed) return segments;

  // More coding
  const code4 = Math.min(30, elapsed - cursor);
  segments.push({ kind: 'coding', startMin: cursor, durationMin: code4, label: 'Recovery' });
  cursor += code4;
  if (cursor >= elapsed) return segments;

  // Fill remaining as idle
  if (cursor < elapsed) {
    segments.push({ kind: 'idle', startMin: cursor, durationMin: elapsed - cursor });
  }

  return segments;
}

// ── Helpers ──

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatTime(minutesSince9am: number): string {
  const h = 9 + Math.floor(minutesSince9am / 60);
  const m = minutesSince9am % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// ── Play Button SVG ──

function PlayIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block' }}>
      <polygon points="5,3 19,12 5,21" />
    </svg>
  );
}

// ── Expand Icon ──

function ExpandIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

// ── Exported mock segments for the expanded view ──
export { generateMockSegments, formatDuration, formatTime, SEGMENT_COLORS, SEGMENT_LABELS };
export type { TimelineSegment, SegmentKind };

// ── Component ──

export function SessionTimeline({ onExpand }: { onExpand?: () => void }) {
  const [hoveredSegment, setHoveredSegment] = useState<number | null>(null);

  const segments = useMemo(() => generateMockSegments(), []);

  const totalMinutes = useMemo(() => {
    if (segments.length === 0) return 0;
    const last = segments[segments.length - 1];
    return last.startMin + last.durationMin;
  }, [segments]);

  // Aggregate by kind for legend
  const kindTotals = useMemo(() => {
    const totals: Partial<Record<SegmentKind, number>> = {};
    for (const seg of segments) {
      totals[seg.kind] = (totals[seg.kind] || 0) + seg.durationMin;
    }
    return totals;
  }, [segments]);

  if (totalMinutes === 0) return null;

  return (
    <div style={{
      height: 36,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px 0 90px', // 90px = traffic light spacer + gap
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
      {/* Left — Label + Play */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}>
        <button
          type="button"
          aria-label="Play session replay"
          style={{
            width: 24,
            height: 24,
            borderRadius: 12,
            border: 'none',
            background: 'rgba(0, 0, 0, 0.06)',
            color: '#374151',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'background 120ms',
            flexShrink: 0,
            padding: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.1)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.06)'; }}
        >
          <PlayIcon />
        </button>
        {onExpand && (
          <button
            type="button"
            aria-label="Expand timeline"
            onClick={onExpand}
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              border: 'none',
              background: 'rgba(0, 0, 0, 0.06)',
              color: '#374151',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'background 120ms',
              flexShrink: 0,
              padding: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.06)'; }}
          >
            <ExpandIcon />
          </button>
        )}
        <span style={{ fontWeight: 600, color: '#374151', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em' }}>
          Session: {formatDuration(totalMinutes)}
        </span>
      </div>

      {/* Center — Segmented bar */}
      <div style={{
        flex: 1,
        height: 18,
        borderRadius: 4,
        overflow: 'hidden',
        display: 'flex',
        background: '#f1f5f9',
        position: 'relative',
      }}>
        {segments.map((seg, i) => {
          const widthPct = (seg.durationMin / totalMinutes) * 100;
          const isHovered = hoveredSegment === i;

          return (
            <div
              key={i}
              onMouseEnter={() => setHoveredSegment(i)}
              onMouseLeave={() => setHoveredSegment(null)}
              style={{
                width: `${widthPct}%`,
                height: '100%',
                background: SEGMENT_COLORS[seg.kind],
                opacity: isHovered ? 1 : 0.85,
                transition: 'opacity 120ms',
                cursor: 'pointer',
                position: 'relative',
                // Thin gap between segments
                borderRight: i < segments.length - 1 ? '1px solid rgba(255,255,255,0.3)' : 'none',
              }}
              title={`${SEGMENT_LABELS[seg.kind]}: ${formatDuration(seg.durationMin)} (${formatTime(seg.startMin)})`}
            >
              {/* Tooltip on hover */}
              {isHovered && (
                <div style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 4,
                  padding: '3px 8px',
                  borderRadius: 6,
                  background: '#1f2937',
                  color: '#fff',
                  fontSize: 10,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  zIndex: 10,
                }}>
                  {seg.label || SEGMENT_LABELS[seg.kind]} · {formatDuration(seg.durationMin)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Right — Legend dots */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
      }}>
        {(['thinking', 'coding', 'testing', 'error'] as SegmentKind[]).map((kind) => {
          const total = kindTotals[kind];
          if (!total) return null;
          return (
            <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <div style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                background: SEGMENT_COLORS[kind],
                flexShrink: 0,
              }} />
              <span style={{ fontSize: 10, color: '#9ca3af' }}>
                {formatDuration(total)}
              </span>
            </div>
          );
        })}
        <span style={{ fontSize: 10, color: '#9ca3af' }}>
          {formatTime(totalMinutes)}
        </span>
      </div>
    </div>
  );
}
