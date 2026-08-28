'use client';

/**
 * SessionTimeline — Day-level activity bar below the TitleBar.
 *
 * Strip pattern adapted from the IntentUI Tracker recipe — flex row of
 * variable-width blocks, near-touching with 1px hair gaps, rounded
 * outer edges. Heavy lifting (data fetch, hover card, drill-down,
 * legend, expand) lives here; the visual primitive is in
 * `./timeline/Tracker.tsx`.
 *
 * Activity blocks carry their `SegmentKind` color; gaps between
 * activities are emitted as transparent filler blocks so the time axis
 * stays linear (10am activity sits visually at the 10am position even
 * if nothing happened at 11am).
 */

import { useMemo, useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import type { FirstMergeCelebrationState } from '@/lib/ftux/first-merge';

import { Tracker, type TrackerBlock, type TrackerHoverInfo } from './timeline/Tracker';
import { ClaudeIcon, CodexIcon, GeminiIcon } from './repo-registry/shared';
import {
  SEGMENT_COLORS,
  SEGMENT_LABELS,
  TIMELINE_BAR_HEIGHT,
} from './timeline/constants';
import type { SegmentKind, TimelineSegment } from './timeline/types';
import {
  cleanTaskLabel,
  compactWorkspacePath,
  formatDuration,
  formatTime,
  humanizeStatus,
  runtimeLabel,
  timelineMatchesAgent,
  timelinePrimarySession,
} from './timeline/helpers';
import { useTimelineData, useTimelineSessions } from './timeline/hooks';
import { ExpandIcon } from './timeline/icons';
import { TimelineButton } from './timeline/TimelineButton';
import { TimelineEmptyState } from './timeline/TimelineEmptyState';

interface SessionTimelineProps {
  onExpand?: () => void;
  repoPath?: string | null;
  repoName?: string | null;
  firstMergeCelebration?: FirstMergeCelebrationState | null;
}

interface BlockMeta {
  /** Original segment, or null for idle filler. */
  segment: TimelineSegment | null;
  /** Absolute start minute (anchored to day start). */
  startMin: number;
  /** Block duration in minutes. */
  durationMin: number;
}

// Idle cells stay visible — muted grey against the chrome bg, mirroring
// the IntentUI Tracker recipe where every cell paints. The token resolves
// to a light divider in light themes and a soft slate in dark.
const IDLE_BLOCK_COLOR = 'var(--t-divider)';
const TIMELINE_BLOCK_GAP = 0.75;
const TIMELINE_TRACK_RADIUS = 5;
const TIMELINE_BLOCK_HEIGHT = TIMELINE_BAR_HEIGHT;
// Pinned 24h rolling window — the strip always represents the last day
// regardless of when the API anchors its segments.
const TIMELINE_WINDOW_MINUTES = 24 * 60;
// 360 cells across the 24h window — each cell = 4 min. Smaller bubbles
// + finer fidelity so two parallel agents in the same hour register as
// distinct slivers instead of collapsing into one 6-min bucket.
const TIMELINE_CELL_COUNT = 360;

// Strip the `cc:` / `codex` / `gemini` agent prefix into a clean
// runtime kind + display name. The route emits `cc:<projectName>` for
// Claude Code, the literal string `codex` for Codex, etc. Centralising
// the parse keeps the hover card memo readable.
type TimelineAgentRuntime = 'codex' | 'claude' | 'gemini' | null;

interface ParsedTimelineAgent {
  runtimeKind: TimelineAgentRuntime;
  runtimeLabel: string | null;
  displayName: string;
}

function parseTimelineAgent(raw: string | undefined | null): ParsedTimelineAgent {
  const value = raw ?? '';
  if (value.startsWith('cc:')) {
    return { runtimeKind: 'claude', runtimeLabel: 'Claude Code', displayName: value.slice(3) || 'Claude Code' };
  }
  if (value === 'codex') return { runtimeKind: 'codex', runtimeLabel: 'Codex', displayName: 'Codex' };
  if (value === 'gemini') return { runtimeKind: 'gemini', runtimeLabel: 'Gemini', displayName: 'Gemini' };
  return { runtimeKind: null, runtimeLabel: null, displayName: value };
}

export function SessionTimeline({
  onExpand,
  repoName,
  firstMergeCelebration,
}: SessionTimelineProps) {
  // The route's `windowMinutes` is informational — the strip's width is
  // pinned to a true 24h rolling window. The anchor is what we DO need
  // — formatTime turns minutesSinceAnchor into the activity's real
  // clock time using it.
  const { segments, anchorMs, loading } = useTimelineData();
  const liveSessions = useTimelineSessions();
  const [hoverInfo, setHoverInfo] = useState<TrackerHoverInfo | null>(null);

  const totalSpan = TIMELINE_WINDOW_MINUTES;
  const hasActivity = segments.length > 0;

  // Bucketed mode — divide the span into N uniform cells. Each cell
  // takes the dominant kind for that time slice (priority on ties:
  // error > coding > testing > thinking > idle), so the strip stays
  // visually full + symmetrical even on a quiet day.
  const { blocks, blockMeta } = useMemo(() => {
    const out: TrackerBlock[] = [];
    const meta: BlockMeta[] = [];
    if (totalSpan <= 0) {
      out.push({ key: 'empty', weight: 1, color: IDLE_BLOCK_COLOR });
      meta.push({ segment: null, startMin: 0, durationMin: totalSpan });
      return { blocks: out, blockMeta: meta };
    }

    const cellCount = TIMELINE_CELL_COUNT;
    const cellSpan = totalSpan / cellCount;
    // Strict priority ladder. Whichever kind is PRESENT in the cell at
    // the highest priority wins — duration is irrelevant. Same rule
    // whether one agent or ten are running in this slice. Surfaces
    // errors first, then real coding, then test runs, then thinking.
    const PRIORITY: SegmentKind[] = ['error', 'coding', 'testing', 'thinking'];

    for (let i = 0; i < cellCount; i += 1) {
      const cellStart = i * cellSpan;
      const cellEnd = cellStart + cellSpan;
      const presentSeg: Partial<Record<SegmentKind, TimelineSegment>> = {};
      for (const seg of segments) {
        if (seg.kind === 'idle') continue;
        const overlap = Math.max(0, Math.min(cellEnd, seg.startMin + seg.durationMin) - Math.max(cellStart, seg.startMin));
        if (overlap <= 0) continue;
        if (!presentSeg[seg.kind]) presentSeg[seg.kind] = seg;
      }

      let winningKind: SegmentKind | null = null;
      for (const kind of PRIORITY) {
        if (presentSeg[kind]) { winningKind = kind; break; }
      }

      const color = winningKind ? SEGMENT_COLORS[winningKind] : IDLE_BLOCK_COLOR;
      out.push({ key: `cell:${i}`, weight: 1, color });
      meta.push({
        segment: winningKind ? presentSeg[winningKind] ?? null : null,
        startMin: cellStart,
        durationMin: cellSpan,
      });
    }

    return { blocks: out, blockMeta: meta };
  }, [segments, totalSpan]);

  const kindTotals = useMemo(() => {
    const totals: Partial<Record<SegmentKind, number>> = {};
    for (const seg of segments) {
      totals[seg.kind] = (totals[seg.kind] || 0) + seg.durationMin;
    }
    return totals;
  }, [segments]);

  const errorSegmentCount = useMemo(
    () => segments.reduce((count, seg) => count + (seg.kind === 'error' ? 1 : 0), 0),
    [segments],
  );

  const liveAgentContext = useMemo(() => {
    const contexts = new Map<string, {
      runtime: string;
      status: string;
      label: string;
      summary: string;
      location: string | null;
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
      contexts.set(agentName, {
        runtime: runtimeLabel(primary.runtime),
        status: primary.status,
        label,
        summary: cleanTask || primary.surfaceLabel || primary.name || 'No current task detail',
        location,
      });
    }
    return contexts;
  }, [segments, liveSessions]);

  const hoveredMeta = hoverInfo ? blockMeta[hoverInfo.blockIndex] ?? null : null;
  const hoveredSeg = hoveredMeta?.segment ?? null;
  const hoveredContext = hoveredSeg?.agent ? liveAgentContext.get(hoveredSeg.agent) ?? null : null;

  // Midnight tick — fraction-based so it slides as time passes. The
  // strip's right edge is "now" and the left edge is "now − 24h", so
  // midnight sits at (1440 − minutesElapsedToday) / 1440 of the way
  // from the left. State + 60s ticker so the marker stays correct
  // across long-open sessions and recomputes after the calendar flips.
  // Hooks must stay above any early returns (rules of hooks).
  const [midnightTickAt, setMidnightTickAt] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setMidnightTickAt(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const midnightFraction = useMemo(() => {
    const now = new Date(midnightTickAt);
    const minutesElapsedToday = now.getHours() * 60 + now.getMinutes();
    return Math.max(0, Math.min(1, 1 - minutesElapsedToday / TIMELINE_WINDOW_MINUTES));
  }, [midnightTickAt]);

  const hoverCard = useMemo(() => {
    if (!hoverInfo || !hoveredMeta) return null;
    const { startMin, durationMin } = hoveredMeta;
    const cursorMin = Math.round(startMin + hoverInfo.blockFraction * durationMin);
    const rangeLabel = hoveredSeg
      ? `${formatTime(startMin, anchorMs)} – ${formatTime(Math.min(totalSpan, startMin + durationMin), anchorMs)}`
      : formatTime(cursorMin, anchorMs);
    const durationLabel = hoveredSeg ? formatDuration(durationMin) : null;
    const kindLabel = hoveredSeg ? SEGMENT_LABELS[hoveredSeg.kind] : 'IDLE';
    const kindColor = hoveredSeg ? SEGMENT_COLORS[hoveredSeg.kind] : 'var(--t-text-faint)';

    const parsedAgent = parseTimelineAgent(hoveredSeg?.agent);
    const resolvedRuntimeLabel = parsedAgent.runtimeLabel ?? hoveredContext?.runtime ?? null;

    return {
      rangeLabel,
      durationLabel,
      kindLabel,
      kindColor,
      agentRuntimeKind: parsedAgent.runtimeKind,
      agentDisplayName: parsedAgent.displayName || (hoveredSeg ? 'Active session' : 'Idle'),
      runtimeLabel: resolvedRuntimeLabel,
      statusLabel: hoveredSeg && hoveredContext?.status ? humanizeStatus(hoveredContext.status) : null,
      locationLabel: hoveredSeg ? hoveredContext?.location ?? null : null,
      summaryLabel: hoveredSeg ? hoveredContext?.summary ?? null : null,
      errorMessage: hoveredSeg?.kind === 'error' ? hoveredSeg.errorMessage ?? null : null,
      isIdle: !hoveredSeg,
    };
  }, [hoverInfo, hoveredMeta, hoveredSeg, hoveredContext, totalSpan, anchorMs]);

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
            borderRadius: 4,
            overflow: 'hidden',
            transformOrigin: 'left center',
            background: 'var(--t-celebration-wash)',
            boxShadow: 'inset 0 0 0 1px var(--t-celebration-border), 0 0 24px var(--t-celebration-glow)',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      ) : null}
    </AnimatePresence>
  );

  if (loading) {
    return (
      <div data-chrome-surface="true" data-stationary-chrome="true" style={chromeStyle}>
        <div style={leftClusterStyle}>
          {onExpand ? <TimelineButton icon={<ExpandIcon />} label="Expand timeline" onClick={onExpand} /> : null}
          <span style={kickerStyle}>Today</span>
        </div>
        <div style={{ flex: 1, height: TIMELINE_BLOCK_HEIGHT, borderRadius: TIMELINE_TRACK_RADIUS, background: 'var(--t-timeline-bar)', position: 'relative', overflow: 'hidden' }}>
          {celebrationWash}
          <div style={shimmerStyle} />
        </div>
        <div style={{ flexShrink: 0, fontSize: 10, color: 'var(--t-text-faint)' }}>Loading activity…</div>
      </div>
    );
  }

  if (!hasActivity) {
    return <TimelineEmptyState onExpand={onExpand} repoName={repoName} />;
  }

  // Inside-the-strip overlays (clipped by Tracker's overflow:hidden):
  // midnight tick + the hover scrubber line.
  const trackerOverlay = (
    <>
      <div
        style={{
          position: 'absolute',
          left: `${midnightFraction * 100}%`,
          top: -2,
          bottom: -2,
          width: 1,
          background: 'var(--t-text-faint)',
          opacity: 0.35,
          pointerEvents: 'none',
          zIndex: 9,
        }}
      />
      {hoverInfo ? (
        <div
          style={{
            position: 'absolute',
            left: hoverInfo.x,
            top: -4,
            bottom: -4,
            width: 1.5,
            background: hoveredSeg ? SEGMENT_COLORS[hoveredSeg.kind] : 'var(--t-text-secondary)',
            borderRadius: 1,
            pointerEvents: 'none',
            zIndex: 10,
            boxShadow: hoveredSeg ? `0 0 6px ${SEGMENT_COLORS[hoveredSeg.kind]}40` : 'none',
          }}
        />
      ) : null}
    </>
  );

  return (
    <motion.div
      data-chrome-surface="true"
      data-stationary-chrome="true"
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      style={chromeStyle}
    >
      <div style={leftClusterStyle}>
        {/* Play button removed per operator pass 2026-05-27 — the
            replay is opened via the Expand affordance + full Session
            Replay page; inline play was unused. */}
        {onExpand ? <TimelineButton icon={<ExpandIcon />} label="Expand timeline" onClick={onExpand} /> : null}
        <span style={kickerStyle}>Last 24h</span>
        {errorSegmentCount > 0 ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 2,
              paddingRight: 7,
              paddingBottom: 2,
              paddingLeft: 7,
              borderRadius: 999,
              background: 'var(--red-soft)',
              color: 'var(--red)',
              fontSize: 10,
              fontWeight: 320,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              fontFamily: 'var(--font-sans-system)',
            }}
            title={`${errorSegmentCount} error block${errorSegmentCount === 1 ? '' : 's'} in the last 24h`}
          >
            <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--red)' }} />
            {errorSegmentCount} error{errorSegmentCount === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        {celebrationWash}
        <Tracker
          blocks={blocks}
          height={TIMELINE_BLOCK_HEIGHT}
          trackBackground="transparent"
          trackRadius={TIMELINE_TRACK_RADIUS}
          blockRadius={2}
          blockGap={TIMELINE_BLOCK_GAP}
          hoveredIndex={hoverInfo?.blockIndex ?? null}
          onHoverMove={setHoverInfo}
          pulseLastBlock
          overlay={trackerOverlay}
        />
      </div>

      <div style={legendStyle}>
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

      {hoverCard && hoverInfo && typeof document !== 'undefined' && createPortal(
        <TimelineHoverCard
          info={hoverInfo}
          card={hoverCard}
        />,
        document.body,
      )}

    </motion.div>
  );
}

const chromeStyle = {
  height: 32,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  paddingTop: 0,
  paddingRight: 16,
  paddingBottom: 0,
  paddingLeft: 90,
  gap: 12,
  background: 'var(--t-chrome, transparent)',
  borderBottom: '0.5px solid var(--t-divider-subtle)',
  fontSize: 11,
  fontWeight: 300,
  color: 'var(--t-text-secondary)',
  letterSpacing: '-0.01em',
  position: 'relative',
  zIndex: 100,
} as const;

const leftClusterStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
  whiteSpace: 'nowrap',
} as const;

const kickerStyle = {
  fontWeight: 300,
  color: 'var(--t-text)',
  textTransform: 'uppercase',
  fontSize: 10,
  letterSpacing: '0.04em',
} as const;

const legendStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexShrink: 0,
} as const;

const shimmerStyle = {
  position: 'absolute',
  inset: 0,
  background: 'linear-gradient(90deg, transparent 0%, var(--t-bg-card) 50%, transparent 100%)',
  animation: 'llmShimmer 1.6s linear infinite',
} as const;

// ─────────────────────────────────────────────────────────────────────
//  Hover card — RepoStatusHover-style. 320px wide, panel-solid surface,
//  StatusRow grid (uppercase 84px label column, ~12px values).
// ─────────────────────────────────────────────────────────────────────

interface HoverCardData {
  rangeLabel: string;
  durationLabel: string | null;
  kindLabel: string;
  kindColor: string;
  agentRuntimeKind: 'codex' | 'claude' | 'gemini' | null;
  agentDisplayName: string;
  runtimeLabel: string | null;
  statusLabel: string | null;
  locationLabel: string | null;
  summaryLabel: string | null;
  errorMessage: string | null;
  isIdle: boolean;
}

const HOVER_CARD_FONT = 'var(--font-sans-system)';
const HOVER_CARD_WIDTH = 320;

function RuntimeGlyph({ kind, size = 14 }: { kind: 'codex' | 'claude' | 'gemini' | null; size?: number }) {
  if (kind === 'claude') return <ClaudeIcon size={size} />;
  if (kind === 'codex') return <CodexIcon size={size} />;
  if (kind === 'gemini') return <GeminiIcon size={size} />;
  return null;
}

function HoverStatusRow({ label, children, tone = 'neutral' }: {
  label: string;
  children: React.ReactNode;
  tone?: 'neutral' | 'attention' | 'danger';
}) {
  const valueColor = tone === 'danger'
    ? 'var(--red)'
    : tone === 'attention'
      ? 'var(--t-celebration)'
      : 'var(--t-text)';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, paddingTop: 4, paddingBottom: 4 }}>
      <div style={{
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--t-text-faint)',
        width: 84,
        flexShrink: 0,
        fontFamily: HOVER_CARD_FONT,
      }}>
        {label}
      </div>
      <div style={{
        flex: 1,
        minWidth: 0,
        fontSize: 12.5,
        fontWeight: 460,
        color: valueColor,
        letterSpacing: '-0.005em',
        fontFamily: HOVER_CARD_FONT,
      }}>
        {children}
      </div>
    </div>
  );
}

function MutedSpan({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--t-text-faint)' }}>{children}</span>;
}

function TimelineHoverCard({ info, card }: { info: TrackerHoverInfo; card: HoverCardData }) {
  const left = Math.min(
    Math.max(12, info.clientX - HOVER_CARD_WIDTH / 2),
    (typeof window !== 'undefined' ? window.innerWidth : HOVER_CARD_WIDTH + 24) - HOVER_CARD_WIDTH - 12,
  );
  const top = info.trackBottom + 10;

  return (
    <div
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 10020,
        width: HOVER_CARD_WIDTH,
        paddingTop: 14,
        paddingRight: 16,
        paddingBottom: 12,
        paddingLeft: 16,
        borderRadius: 12,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel-solid)',
        boxShadow: 'var(--t-panel-shadow)',
        color: 'var(--t-text)',
        pointerEvents: 'none',
        fontFamily: HOVER_CARD_FONT,
      }}
    >
      {/* Header — agent icon + name (or kind for idle) + duration on the right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        {card.agentRuntimeKind ? (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            background: 'var(--t-bg-card)',
            border: '1px solid var(--t-divider-subtle)',
            flexShrink: 0,
          }}>
            <RuntimeGlyph kind={card.agentRuntimeKind} size={13} />
          </div>
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13.5,
            fontWeight: 300,
            letterSpacing: '-0.012em',
            color: 'var(--t-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {card.agentDisplayName}
          </div>
          {card.runtimeLabel || card.kindLabel ? (
            <div style={{
              fontSize: 10.5,
              color: 'var(--t-text-faint)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              marginTop: 1,
            }}>
              {[card.runtimeLabel, card.isIdle ? null : card.kindLabel].filter(Boolean).join(' · ')}
            </div>
          ) : null}
        </div>
        {card.durationLabel ? (
          <div style={{
            fontSize: 11,
            fontWeight: 320,
            whiteSpace: 'nowrap',
            paddingTop: 4,
            paddingRight: 8,
            paddingBottom: 4,
            paddingLeft: 8,
            borderRadius: 999,
            background: `${card.kindColor}18`,
            color: card.kindColor,
            letterSpacing: '0.02em',
          } as React.CSSProperties}>
            {card.durationLabel}
          </div>
        ) : null}
      </div>

      <div style={{ height: 1, background: 'var(--t-divider-subtle)', marginTop: 2, marginRight: -16, marginBottom: 6, marginLeft: -16 }} />

      <HoverStatusRow label="Time">
        <span>{card.rangeLabel}</span>
      </HoverStatusRow>

      {card.statusLabel ? (
        <HoverStatusRow label="Status" tone="attention">
          <span>{card.statusLabel}</span>
        </HoverStatusRow>
      ) : null}

      {card.locationLabel ? (
        <HoverStatusRow label="Repo">
          <span style={{ fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', fontSize: 11.5 }}>
            {card.locationLabel}
          </span>
        </HoverStatusRow>
      ) : null}

      {card.summaryLabel ? (
        <HoverStatusRow label="Activity">
          <span style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            lineHeight: 1.4,
          }}>
            {card.summaryLabel}
          </span>
        </HoverStatusRow>
      ) : null}

      {card.errorMessage ? (
        <HoverStatusRow label="Error" tone="danger">
          <span style={{
            fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
            fontSize: 11.5,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            lineHeight: 1.4,
          }}>
            {card.errorMessage}
          </span>
        </HoverStatusRow>
      ) : null}

      {card.isIdle ? (
        <HoverStatusRow label="Window">
          <MutedSpan>Quiet — no agent activity</MutedSpan>
        </HoverStatusRow>
      ) : null}
    </div>
  );
}
