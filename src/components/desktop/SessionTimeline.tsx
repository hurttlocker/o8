'use client';

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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import type { FirstMergeCelebrationState } from '@/lib/ftux/first-merge';

import {
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  TIMELINE_BAR_HEIGHT,
  TIMELINE_DRILLDOWN_ENABLED,
} from './timeline/constants';
import type { SegmentKind, TimelineSegmentGeometry } from './timeline/types';
import {
  cleanTaskLabel,
  compactWorkspacePath,
  formatDuration,
  formatTime,
  humanizeStatus,
  runtimeLabel,
  timelineMatchesAgent,
  timelinePrimarySession,
  timelineSegmentChrome,
  timelineSegmentDisplayWidth,
  timelineSegmentLayer,
} from './timeline/helpers';
import { useTimelineData, useTimelineSessions } from './timeline/hooks';
import { PlayIcon, ExpandIcon } from './timeline/icons';
import { TimelineButton } from './timeline/TimelineButton';
import { TimelineEmptyState } from './timeline/TimelineEmptyState';
import { TimelineDrilldown } from './timeline/TimelineDrilldown';

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
  const [hoveredSegIdx, setHoveredSegIdx] = useState<number | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);

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

    const agentNames = new Set<string>();
    for (const seg of segments) {
      if (seg.agent) agentNames.add(seg.agent);
    }

    for (const agentName of agentNames) {
      const matches = liveSessions.filter((session) => timelineMatchesAgent(agentName, session));
      const primary = timelinePrimarySession(matches);
      if (!primary) continue;

      const repoSlug = primary.runtimeSurface?.reviewContext?.repoSlug || '';
      const matchedRepoName = repoSlug.split('/')[1] || null;
      const cleanTask = cleanTaskLabel(primary.currentTask);
      const location = matchedRepoName
        ? `${matchedRepoName}${primary.branch ? ` · ${primary.branch}` : ''}`
        : compactWorkspacePath(primary.workspace) ?? primary.surfaceLabel ?? primary.branch ?? null;
      const label = primary.surfaceLabel || primary.name || runtimeLabel(primary.runtime);
      const extra = matches.length > 1 ? `+${matches.length - 1} more` : null;

      contexts.set(agentName, {
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
  }, [segments, liveSessions]);

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
          }}
        >
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
            onDoubleClick={TIMELINE_DRILLDOWN_ENABLED ? () => setDrillOpen(true) : undefined}
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

          {TIMELINE_DRILLDOWN_ENABLED && drillOpen && (
            <TimelineDrilldown
              segments={segments}
              totalSpan={totalSpan}
              repoPath={repoPath}
              repoName={repoName}
              onClose={() => setDrillOpen(false)}
            />
          )}
        </motion.div>
      ) : (
        <TimelineEmptyState onExpand={onExpand} repoName={repoName} />
      )}
    </AnimatePresence>
  );
}
