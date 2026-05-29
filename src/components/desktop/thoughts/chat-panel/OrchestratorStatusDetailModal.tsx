'use client';

/**
 * OrchestratorStatusDetailModal — the click-through detail view for a status
 * card. Explains, in plain language, exactly what happened (so the operator is
 * never left guessing) plus Issues-style metadata rows. Portal overlay, themed
 * throughout (bg + text from the same palette, so it reads in light + midnight),
 * Esc / backdrop to close.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  humanizeLaneStatus,
  statusEventSummary,
  type OrchestratorStatusEventData,
} from '@/lib/orchestrator/status-events';
import { StatusGlyph } from './status-glyphs';

const TONE_STROKE: Record<'success' | 'attention', { stroke: string; badge: string }> = {
  success: { stroke: '#22c55e', badge: 'rgba(34, 197, 94, 0.12)' },
  attention: { stroke: '#f59e0b', badge: 'rgba(245, 158, 11, 0.13)' },
};

function detailContent(event: OrchestratorStatusEventData): { explain: string; rows: { label: string; value: string }[] } {
  switch (event.kind) {
    case 'mission-complete':
      return {
        explain: 'Every packet in this mission was reviewed, merged into the base branch, and its lane archived. The thread is ready for your next mission.',
        rows: [
          { label: 'Merged', value: `${event.mergedCount} ${event.mergedCount === 1 ? 'packet' : 'packets'}` },
          ...(typeof event.archivedCount === 'number'
            ? [{ label: 'Archived', value: `${event.archivedCount} ${event.archivedCount === 1 ? 'lane' : 'lanes'}` }]
            : []),
          ...(event.summary ? [{ label: 'Summary', value: event.summary }] : []),
        ],
      };
    case 'merge':
      return {
        explain: `These changes were reviewed and merged into ${event.branch || 'the base branch'}. The packet's worktree lane is now retired.`,
        rows: [
          { label: 'Packet', value: event.packetTitle },
          ...(event.branch ? [{ label: 'Branch', value: event.branch }] : []),
          ...(event.runtime ? [{ label: 'Runtime', value: event.runtime }] : []),
        ],
      };
    case 'heal':
      return event.outcome === 'recovered'
        ? {
            explain: `o8 detected a failed step${event.previousStatus ? ` (${humanizeLaneStatus(event.previousStatus)})` : ''} and automatically recovered this lane — re-running it through the orchestrator. No action needed from you.`,
            rows: [
              ...(event.packetTitle ? [{ label: 'Packet', value: event.packetTitle }] : []),
              { label: 'Outcome', value: 'Recovered automatically' },
              ...(event.previousStatus ? [{ label: 'Recovered from', value: humanizeLaneStatus(event.previousStatus) }] : []),
            ],
          }
        : {
            explain: `Automatic recovery couldn't resolve the failure${event.previousStatus ? ` (${humanizeLaneStatus(event.previousStatus)})` : ''}, so the lane is paused for your input. Open it from the inbox to steer or restart it.`,
            rows: [
              ...(event.packetTitle ? [{ label: 'Packet', value: event.packetTitle }] : []),
              { label: 'Outcome', value: 'Needs your input' },
              ...(event.previousStatus ? [{ label: 'After', value: humanizeLaneStatus(event.previousStatus) }] : []),
            ],
          };
  }
}

export function OrchestratorStatusDetailModal({
  event,
  timestampLabel,
  onClose,
}: {
  event: OrchestratorStatusEventData;
  timestampLabel?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  const { title, tone } = statusEventSummary(event);
  const palette = TONE_STROKE[tone];
  const { explain, rows } = detailContent(event);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(8, 11, 18, 0.42)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        padding: 24,
        animation: 'o8StatusModalFade 180ms ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 440,
          borderRadius: 16,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-panel-border)',
          background: 'var(--t-panel-solid)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.32)',
          overflow: 'hidden',
          fontFamily: 'var(--font-sans-system)',
          animation: 'o8StatusModalIn 240ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            paddingTop: 16,
            paddingBottom: 16,
            paddingLeft: 18,
            paddingRight: 14,
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider)',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: 11,
              background: palette.badge,
              flexShrink: 0,
            }}
          >
            <StatusGlyph event={event} stroke={palette.stroke} size={19} animate={false} />
          </span>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: 400, color: 'var(--t-text-strong, var(--t-text))', letterSpacing: '-0.1px' }}>
              {title}
            </span>
            {timestampLabel ? (
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--t-text-faint)', letterSpacing: '-0.005em' }}>
                {timestampLabel}
              </span>
            ) : null}
          </div>
          <CloseButton onClose={onClose} />
        </div>

        {/* Body */}
        <div style={{ paddingTop: 16, paddingBottom: 16, paddingLeft: 18, paddingRight: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, fontSize: 12.5, fontWeight: 300, lineHeight: 1.55, color: 'var(--t-text-secondary)', letterSpacing: '-0.1px' }}>
            {explain}
          </p>
          {rows.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, borderRadius: 10, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', overflow: 'hidden' }}>
              {rows.map((row, idx) => (
                <div
                  key={row.label}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 12,
                    paddingTop: 9,
                    paddingBottom: 9,
                    paddingLeft: 12,
                    paddingRight: 12,
                    borderTopWidth: idx === 0 ? 0 : 1,
                    borderTopStyle: 'solid',
                    borderTopColor: 'var(--t-divider-subtle, var(--t-divider))',
                    background: idx % 2 === 1 ? 'var(--t-input-bg)' : 'transparent',
                  }}
                >
                  <span style={{ flexShrink: 0, width: 96, fontSize: 9.5, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
                    {row.label}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 400, color: 'var(--t-text)', letterSpacing: '-0.005em', lineHeight: 1.45, wordBreak: 'break-word' }}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 18,
            paddingRight: 18,
            borderTopWidth: 1,
            borderTopStyle: 'solid',
            borderTopColor: 'var(--t-divider)',
          }}
        >
          <FooterButton onClose={onClose} />
        </div>
      </div>

      <style>{`
        @keyframes o8StatusModalFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes o8StatusModalIn { 0% { opacity: 0; transform: translateY(10px) scale(0.97); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
      `}</style>
    </div>,
    document.body,
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 8,
        borderWidth: 0,
        background: 'transparent',
        color: 'var(--t-text-muted)',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-muted)'; }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" />
      </svg>
    </button>
  );
}

function FooterButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 30,
        paddingLeft: 16,
        paddingRight: 16,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border)',
        background: 'var(--t-panel)',
        color: 'var(--t-text)',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 400,
        lineHeight: 1,
        letterSpacing: '-0.1px',
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 120ms ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-bg-card)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--t-panel)'; }}
    >
      Got it
    </button>
  );
}
