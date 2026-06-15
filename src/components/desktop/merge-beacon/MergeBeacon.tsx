'use client';

/**
 * MergeBeacon — a fleet-wide "something's ready to land / needs you" pill in
 * the bottom status bar, sitting just left of MergeActionCluster (which it
 * never touches). It surfaces lanes parked in the review/escalation gates
 * (see derive.ts) so the operator sees a worker is ready even when heads-down
 * on the orchestrator and not watching the worker tabs.
 *
 * Pure signal: returns null when nothing is parked, so it only appears when
 * there's genuinely something waiting. Click → a popover list of the parked
 * lanes; clicking a row re-points the existing merge cluster + workspace
 * context at that lane's branch (reuses the o8:orchestrator-worktree-selection
 * wire the dashboard already listens for).
 */

import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ParkedLane } from './derive';

const STATUS_WORD: Record<string, string> = {
  reviewing: 'review',
  awaiting_orchestrator: 'escalated',
  awaiting_human: 'needs you',
};

function statusWord(status: string): string {
  return STATUS_WORD[status] ?? status;
}

function MergeBeaconBase({ parked, compact }: { parked: ParkedLane[]; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Popover opens UPWARD (the status bar is pinned to the screen bottom),
  // positioned via the anchor rect through a portal so the thin status strip
  // never clips it.
  const [coords, setCoords] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const compute = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 332));
      setCoords({ left, bottom: window.innerHeight - rect.top + 6 });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (anchorRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Nothing parked anymore -> drop the popover too.
  useEffect(() => {
    if (parked.length === 0 && open) setOpen(false);
  }, [parked.length, open]);

  if (compact || parked.length === 0) return null;

  const count = parked.length;

  const focusLane = (lane: ParkedLane) => {
    if (typeof window === 'undefined') return;
    if (lane.branch) {
      window.dispatchEvent(new CustomEvent('o8:orchestrator-worktree-selection', {
        detail: {
          tabId: 'merge-beacon',
          repoPath: lane.repoPath ?? null,
          branch: lane.branch,
          worktreeMode: 'new-worktree',
        },
      }));
    }
    setOpen(false);
  };

  return (
    <div ref={anchorRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${count} ready to merge`}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 22,
          paddingLeft: 8,
          paddingRight: 9,
          borderRadius: 7,
          borderWidth: 1,
          borderStyle: 'solid',
          // Brand-orange (#FF5A1F) tints — the "needs you" LED. A colored
          // accent (reads on both light + dark), not a neutral surface.
          borderColor: 'rgba(255, 90, 31, 0.26)',
          background: 'rgba(255, 90, 31, 0.12)',
          color: 'var(--t-brand-orange)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 11.5,
          fontWeight: 500,
          letterSpacing: '-0.005em',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--t-brand-orange)', flexShrink: 0 }} />
        {count} ready
      </button>
      {open && typeof document !== 'undefined' && coords ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: 'fixed',
            left: coords.left,
            bottom: coords.bottom,
            minWidth: 220,
            maxWidth: 324,
            background: 'var(--t-panel-solid, var(--t-panel))',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider, var(--t-divider-subtle))',
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(15, 23, 42, 0.22)',
            paddingTop: 4,
            paddingBottom: 4,
            zIndex: 1200,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          <div
            style={{
              paddingTop: 6,
              paddingBottom: 4,
              paddingLeft: 12,
              paddingRight: 12,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--t-text-faint)',
            }}
          >
            Ready to merge
          </div>
          {parked.map((lane) => (
            <button
              key={lane.laneId}
              type="button"
              onClick={() => focusLane(lane)}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                paddingTop: 7,
                paddingBottom: 7,
                paddingLeft: 12,
                paddingRight: 12,
                background: 'transparent',
                borderWidth: 0,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--t-brand-orange)', flexShrink: 0 }} />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 12,
                  color: 'var(--t-text)',
                }}
              >
                {lane.label || lane.branch || lane.packetId}
              </span>
              <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--t-text-faint)' }}>
                {statusWord(lane.status)}
              </span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export const MergeBeacon = memo(MergeBeaconBase);
