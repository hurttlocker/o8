'use client';

/**
 * MissionCompleteGroupCard — collapses a run of ≥2 consecutive mission-complete
 * cards into ONE aggregate ("N packets merged & archived"). Click to expand into
 * the individual OrchestratorStatusCards, each of which self-expands to its own
 * "what shipped" detail. Three-level disclosure, one card at rest — so a burst of
 * merges reads as a single event instead of a redundant stack.
 *
 * House rules: inline styles only, raw SVG icons, CSS-keyframe motion. Neutral
 * card surface (matches OrchestratorStatusCard); the accent rides only the badge.
 */

import { useState } from 'react';
import type { OrchestratorStatusEventData } from '@/lib/orchestrator/status-events';
import { OrchestratorStatusCard } from './OrchestratorStatusCard';

export interface GroupedMissionEntry {
  key: string;
  event: OrchestratorStatusEventData;
  timestampLabel?: string;
}

const SUCCESS_STROKE = '#22c55e';
const SUCCESS_BADGE = 'rgba(34, 197, 94, 0.12)';

export function MissionCompleteGroupCard({
  entries,
  isLast,
}: {
  entries: GroupedMissionEntry[];
  isLast?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);

  const totalMerged = entries.reduce(
    (sum, e) => sum + (e.event.kind === 'mission-complete' ? (e.event.mergedCount ?? 0) : 0),
    0,
  );
  const latestTs = entries[entries.length - 1]?.timestampLabel;
  const headline = `${totalMerged} ${totalMerged === 1 ? 'packet' : 'packets'} merged & archived`;
  const sub = `${entries.length} missions`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', marginBottom: isLast ? 32 : undefined }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-expanded={open}
        aria-label={`${headline} across ${entries.length} missions — ${open ? 'hide' : 'view'} each`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          width: '100%',
          maxWidth: 'min(440px, 92%)',
          borderRadius: 12,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: hover ? 'var(--t-border)' : 'var(--t-divider)',
          background: hover ? 'var(--t-bg-card)' : 'var(--t-input-bg)',
          boxShadow: 'none',
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 12,
          paddingRight: 12,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-sans-system)',
          transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
          animation: isLast ? 'o8StatusCardIn 440ms cubic-bezier(0.22, 1, 0.36, 1) both' : undefined,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 9,
            background: SUCCESS_BADGE,
            flexShrink: 0,
          }}
        >
          {/* stacked layers — signals "several missions rolled into one" */}
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={SUCCESS_STROKE} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2 2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </span>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--t-text)', letterSpacing: '-0.1px', lineHeight: 1.3 }}>
            {headline}
          </span>
          <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)', letterSpacing: '-0.1px', lineHeight: 1.35 }}>
            {sub}
          </span>
        </div>

        {latestTs ? (
          <span style={{ fontSize: 10, color: 'var(--t-text-faint)', flexShrink: 0, fontWeight: 400 }}>{latestTs}</span>
        ) : null}

        <svg
          width={11}
          height={11}
          viewBox="0 0 12 12"
          fill="none"
          stroke="var(--t-text-faint)"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0, opacity: hover ? 0.9 : 0.5, transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'opacity 140ms ease, transform 200ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        >
          <path d="M4.5 2.5 L8 6 L4.5 9.5" />
        </svg>

        <style>{`
          @keyframes o8StatusCardIn { 0% { opacity: 0; transform: translateY(6px) scale(0.985); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
          @keyframes o8StatusDrawerIn { 0% { opacity: 0; transform: translateY(-5px); } 100% { opacity: 1; transform: translateY(0); } }
        `}</style>
      </button>

      {open ? (
        <div
          style={{
            width: '100%',
            maxWidth: 'min(440px, 92%)',
            marginTop: 8,
            paddingLeft: 15,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            borderLeft: '1px solid var(--t-divider)',
            animation: 'o8StatusDrawerIn 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          {entries.map((e) => (
            <OrchestratorStatusCard key={e.key} event={e.event} timestampLabel={e.timestampLabel} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
