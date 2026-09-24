'use client';

/**
 * DesktopStatusBar — compact chrome strip pinned to the bottom of the dashboard.
 *
 * Holds workspace utilities when no composer is active and places them in the
 * composer context row when one is active. Account controls live in AgentPanel.
 */

import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ParkedLane } from './merge-beacon/derive';
import { Terminal as TablerTerminal } from './tabler-shims';
import { ViewAsFreeIndicator } from './ViewAsFreeIndicator';
import { getRegisteredComposerCenter, subscribeToComposerCenter } from './composer-center-registry';
import { useEntitlement } from '@/lib/entitlement/context';

interface DesktopStatusBarProps {
  /** Retained for the caller; merge state is no longer displayed in this chrome. */
  branchName: string | null;
  repoName: string | null;
  repoRemoteUrl?: string | null;
  defaultBranch?: string | null;
  /** Width of the right panel column when visible, in CSS px. */
  rightColumnWidth?: number;
  /** Narrow desktop mode: keep durable status text and collapse action chrome. */
  compact?: boolean;
  /** Glass surface active: leave the left utility rail transparent. */
  glassSurface?: boolean;
  parkedLanes?: ParkedLane[];
  onOpenReviewLane?: (lane: ParkedLane) => void;
  onOpenAwaitingMerge?: () => void;
  /** Open the keyboard-shortcuts reference overlay (also bound to ⌘/). */
  onOpenShortcuts?: () => void;
}

function DesktopStatusBarBase({
  onOpenShortcuts,
  rightColumnWidth,
  compact = false,
}: DesktopStatusBarProps) {
  const { overrideActive } = useEntitlement();

  // The composer card registers its status slot so small utility controls can
  // follow it without painting a second bar underneath the input.
  const [composerSlot, setComposerSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let raf = 0;
    const measure = () => {
      const el = getRegisteredComposerCenter();
      const slot = el?.closest<HTMLElement>('[data-o8-composer-root]')?.querySelector<HTMLElement>('[data-o8-composer-status-slot]') ?? null;
      setComposerSlot((prev) => prev === slot ? prev : slot);
    };
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(measure);
    };
    const unsubscribe = subscribeToComposerCenter(schedule);
    schedule();
    window.addEventListener('resize', schedule);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      unsubscribe();
    };
  }, []);

  if (composerSlot) {
    return createPortal(
      <div data-o8-composer-chrome="" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        {!compact && overrideActive ? <ViewAsFreeIndicator palette="chrome" /> : null}
        {!compact && onOpenShortcuts ? <StatusShortcutsButton onClick={onOpenShortcuts} /> : null}
      </div>,
      composerSlot,
    );
  }

  // Merge review lives in the review surfaces. The bottom-panel control now
  // lives in the workspace header, so this bar only carries fallback help.
  return (
    <div
      data-mcp-scope="desktop-status-bar"
      data-chrome-surface="true"
      data-stationary-chrome="true"
      style={{
        // Established height for the utility controls and center/right chrome.
        height: 36,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        background: 'transparent',
        borderTopWidth: 0,
        fontFamily: 'var(--font-sans-system)',
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      {/* Flow spacer keeps the right-edge chrome (the ? button) pinned right. */}
      <div style={{ flex: 1, minWidth: 0 }} />

      <div
        style={{
          width: compact ? 0 : (rightColumnWidth ?? undefined),
          flexShrink: 0,
          display: compact ? 'none' : 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingLeft: compact ? 0 : 12,
          paddingRight: compact ? 0 : 12,
          gap: 6,
        }}
      >
        {overrideActive ? <ViewAsFreeIndicator palette="chrome" /> : null}
        {onOpenShortcuts ? <StatusShortcutsButton onClick={onOpenShortcuts} /> : null}
      </div>
    </div>
  );
}

export const DesktopStatusBar = memo(DesktopStatusBarBase);

/** Open or close the bottom utility panel. Surfaces are added inside the panel. */
export function StatusBottomPanelControl({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={active ? 'Close bottom panel' : 'Open bottom panel'}
      title={active ? 'Close bottom panel' : 'Open bottom panel'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 26,
        borderRadius: 8,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: active ? 'var(--t-accent)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      <TerminalGlyph size={14} />
    </button>
  );
}

function TerminalGlyph({ size = 14 }: { size?: number }) {
  // Tabler Terminal2 — operator-locked icon for the bottom-area
  // terminal affordance. See Hurttlocker.md§"Icon vocabulary".
  return <TablerTerminal size={size} strokeWidth={2} />;
}

/** `?` button — opens the keyboard-shortcuts reference. Sits at the
 *  right edge of the status bar where global help affordances belong. */
function StatusShortcutsButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="Keyboard shortcuts"
      aria-haspopup="dialog"
      title="Keyboard shortcuts (⌘/)"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: hovered ? 'var(--t-text)' : 'var(--t-text-faint)',
        cursor: 'pointer',
        padding: 0,
        fontSize: 12,
        fontWeight: 700,
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      ?
    </button>
  );
}
