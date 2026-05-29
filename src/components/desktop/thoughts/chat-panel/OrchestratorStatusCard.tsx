'use client';

/**
 * OrchestratorStatusCard — themed, animated card for orchestrator lifecycle
 * events (today: mission complete). Replaces the plain gray system-message
 * bubble that used to render cryptic tokens like
 * "(MISSION COMPLETE · 2 MERGES · ARCHIVED)" / "(NEW THREAD · READY)".
 *
 * `detectOrchestratorStatusEvent` reads the system entry's text and recognizes
 * both the new human-readable line AND the legacy all-caps tokens, so old
 * threads tidy up in place (no migration needed) and the redundant
 * "new thread ready" marker is suppressed.
 *
 * House rules: inline styles only, raw SVG icons, CSS-keyframe motion (the chat
 * area uses keyframes, not framer-motion). hurttlocker restraint: neutral card
 * surface, the success accent rides only on a small icon badge — never a loud
 * tinted surface (which would also blob in midnight).
 */

export type OrchestratorStatusEvent =
  | { kind: 'mission-complete'; mergedCount: number }
  | { kind: 'suppress' };

// Recognize an orchestrator status/lifecycle event from a system message's
// text. Returns null for ordinary system messages (errors, notices) so they
// keep their normal bubble.
export function detectOrchestratorStatusEvent(text: string): OrchestratorStatusEvent | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  // Legacy "(NEW THREAD · READY)" — redundant with the mission-complete card.
  if (/^\(\s*NEW THREAD\b/i.test(trimmed)) return { kind: 'suppress' };
  // Legacy "(MISSION COMPLETE · 2 MERGES · ARCHIVED)"
  if (/^\(\s*MISSION COMPLETE\b/i.test(trimmed)) {
    const match = trimmed.match(/·\s*(\d+)\s*MERGE/i);
    return { kind: 'mission-complete', mergedCount: match ? parseInt(match[1], 10) : 0 };
  }
  // New "Mission complete — 2 packets merged and archived. …"
  if (/^Mission complete\b/i.test(trimmed)) {
    const match = trimmed.match(/(\d+)\s*packets?/i);
    return { kind: 'mission-complete', mergedCount: match ? parseInt(match[1], 10) : 0 };
  }
  // New "Mission archived. …" (no merges)
  if (/^Mission archived\b/i.test(trimmed)) {
    return { kind: 'mission-complete', mergedCount: 0 };
  }
  return null;
}

const ACCENT = '#22c55e'; // success green — matches the merged read-only banner

function describe(event: Exclude<OrchestratorStatusEvent, { kind: 'suppress' }>): { title: string; detail: string } {
  const count = event.mergedCount;
  return {
    title: 'Mission complete',
    detail: count > 0
      ? `${count} ${count === 1 ? 'packet' : 'packets'} merged and archived`
      : 'Archived · ready for the next mission',
  };
}

function CheckGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path
        d="M3.5 8.4 L6.5 11.4 L12.5 4.6"
        style={{ strokeDasharray: 17, strokeDashoffset: 17, animation: 'o8StatusCheckDraw 440ms cubic-bezier(0.22, 1, 0.36, 1) 140ms forwards' }}
      />
    </svg>
  );
}

export function OrchestratorStatusCard({
  event,
  timestampLabel,
  isLast,
}: {
  event: OrchestratorStatusEvent;
  timestampLabel?: string;
  isLast?: boolean;
}) {
  if (event.kind === 'suppress') return null;
  const { title, detail } = describe(event);
  return (
    <div
      role="group"
      aria-label={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        maxWidth: 'min(440px, 92%)',
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'var(--t-input-bg)',
        boxShadow: 'var(--t-panel-shadow)',
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 12,
        paddingRight: 14,
        fontFamily: 'var(--font-sans-system)',
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
          background: 'rgba(34, 197, 94, 0.12)',
          flexShrink: 0,
          animation: isLast ? 'o8StatusBadgePop 460ms cubic-bezier(0.22, 1, 0.36, 1) both' : undefined,
        }}
      >
        <CheckGlyph />
      </span>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text)', letterSpacing: '-0.01em', lineHeight: 1.3 }}>
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

      <style>{`
        @keyframes o8StatusCardIn { 0% { opacity: 0; transform: translateY(6px) scale(0.985); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes o8StatusBadgePop { 0% { opacity: 0; transform: scale(0.62); } 60% { transform: scale(1.06); } 100% { opacity: 1; transform: scale(1); } }
        @keyframes o8StatusCheckDraw { to { stroke-dashoffset: 0; } }
      `}</style>
    </div>
  );
}
