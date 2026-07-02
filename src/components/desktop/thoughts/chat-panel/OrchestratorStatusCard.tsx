'use client';

/**
 * OrchestratorStatusCard — themed, animated card for orchestrator lifecycle
 * events (mission complete, packet merged, lane self-healed / needs-human).
 * Replaces the plain gray system bubble. Clicking the card expands an inline
 * detail drawer right below it (a drop-down, NOT a modal) so the operator can
 * see exactly what happened without a flow-breaking overlay.
 *
 * House rules: inline styles only, raw SVG icons, CSS-keyframe motion. hurttlocker
 * restraint — neutral card surface; the accent rides only on a small icon badge.
 */

import { useState } from 'react';
import {
  statusEventSummary,
  type OrchestratorStatusEventData,
  type StatusEventTone,
} from '@/lib/orchestrator/status-events';
import { OrchestratorStatusDetailBody } from './OrchestratorStatusDetail';
import { StatusGlyph } from './status-glyphs';

const TONE: Record<StatusEventTone, { stroke: string; badge: string }> = {
  success: { stroke: '#22c55e', badge: 'rgba(34, 197, 94, 0.12)' },
  attention: { stroke: '#f59e0b', badge: 'rgba(245, 158, 11, 0.13)' },
};

export function OrchestratorStatusCard({
  event,
  timestampLabel,
  isLast,
}: {
  event: OrchestratorStatusEventData;
  timestampLabel?: string;
  isLast?: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const { title, detail, tone } = statusEventSummary(event);
  const palette = TONE[tone];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', marginBottom: isLast ? 32 : undefined }}>
      <button
        type="button"
        onClick={() => setDetailOpen((open) => !open)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-expanded={detailOpen}
        aria-label={`${title} — ${detailOpen ? 'hide' : 'view'} details`}
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
            background: palette.badge,
            flexShrink: 0,
            animation: isLast ? 'o8StatusBadgePop 460ms cubic-bezier(0.22, 1, 0.36, 1) both' : undefined,
          }}
        >
          <StatusGlyph event={event} stroke={palette.stroke} />
        </span>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--t-text)', letterSpacing: '-0.1px', lineHeight: 1.3 }}>
            {title}
          </span>
          {detail ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 300,
                color: 'var(--t-text-muted)',
                letterSpacing: '-0.1px',
                lineHeight: 1.35,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {detail}
            </span>
          ) : null}
        </div>

        {timestampLabel ? (
          <span style={{ fontSize: 10, color: 'var(--t-text-faint)', flexShrink: 0, fontWeight: 400 }}>
            {timestampLabel}
          </span>
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
          style={{ flexShrink: 0, opacity: hover ? 0.9 : 0.5, transform: detailOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'opacity 140ms ease, transform 200ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        >
          <path d="M4.5 2.5 L8 6 L4.5 9.5" />
        </svg>

        <style>{`
          @keyframes o8StatusCardIn { 0% { opacity: 0; transform: translateY(6px) scale(0.985); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
          @keyframes o8StatusBadgePop { 0% { opacity: 0; transform: scale(0.62); } 60% { transform: scale(1.06); } 100% { opacity: 1; transform: scale(1); } }
          @keyframes o8StatusGlyphDraw { to { stroke-dashoffset: 0; } }
          @keyframes o8StatusDrawerIn { 0% { opacity: 0; transform: translateY(-5px); } 100% { opacity: 1; transform: translateY(0); } }
          @keyframes o8StatusDrawerFade { from { opacity: 0.45; } to { opacity: 1; } }
        `}</style>
      </button>

      {detailOpen ? (
        <div
          style={{
            width: '100%',
            maxWidth: 'min(440px, 92%)',
            marginTop: 6,
            borderRadius: 12,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'var(--t-bg-card)',
            boxShadow: 'none',
            overflow: 'hidden',
            animation: 'o8StatusDrawerIn 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <OrchestratorStatusDetailBody event={event} />
        </div>
      ) : null}
    </div>
  );
}
