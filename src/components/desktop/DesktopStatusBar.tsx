'use client';

/**
 * DesktopStatusBar — compact chrome strip pinned to the bottom of the dashboard.
 *
 * Holds sidebar utilities, workspace-centered merge and branch state, and
 * right-edge utilities. Account controls live in AgentPanel.
 */

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MergeActionCluster } from './MergeActionCluster';
import { MergeBeacon } from './merge-beacon/MergeBeacon';
import type { ParkedLane } from './merge-beacon/derive';
import { Terminal as TablerTerminal } from './tabler-shims';
import { CircleSpark, DoubleCheck, Folder, Internet } from 'iconoir-react';
import { ViewAsFreeIndicator } from './ViewAsFreeIndicator';
import { useEntitlement } from '@/lib/entitlement/context';
import type { BottomPanelSurfaceKind } from './ContextualPanel';

interface DesktopStatusBarProps {
  branchName: string | null;
  repoName: string | null;
  repoRemoteUrl?: string | null;
  /** Width of the left AgentPanel column, in CSS px. The bottom bar uses
   *  this to align its left chrome with the column above so the centered
   *  merge cluster lands directly under the workspace surface. */
  leftColumnWidth?: number;
  /** Width of the right panel column when visible, in CSS px. */
  rightColumnWidth?: number;
  /** Narrow desktop mode: keep durable status text and collapse action chrome. */
  compact?: boolean;
  /** Glass surface active: leave the left utility rail transparent. */
  glassSurface?: boolean;
  /** Lanes parked in the review gate — drives the merge beacon split between
   *  needs-review and approved-awaiting-merge. */
  parkedLanes?: ParkedLane[];
  onOpenReviewLane?: (lane: ParkedLane) => void;
  onOpenAwaitingMerge?: () => void;
  /** Contextual bottom-panel (terminal) toggle. Moved from the column
   *  header per operator request — sits in the status bar's center
   *  column next to the branch label. */
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
  onOpenBottomPanelSurface?: (surface: BottomPanelSurfaceKind) => void;
  /** Open the keyboard-shortcuts reference overlay (also bound to ⌘/). */
  onOpenShortcuts?: () => void;
}

function DesktopStatusBarBase({
  branchName,
  repoName,
  repoRemoteUrl = null,
  bottomPanelVisible = false,
  onToggleBottomPanel,
  onOpenBottomPanelSurface,
  onOpenShortcuts,
  leftColumnWidth,
  rightColumnWidth,
  compact = false,
  glassSurface = false,
  parkedLanes = [],
  onOpenReviewLane,
  onOpenAwaitingMerge,
}: DesktopStatusBarProps) {
  const { founder, overrideActive } = useEntitlement();

  // Center the branch cluster on the composer's REAL measured position. The
  // column-width props ignored insets/gaps + a hidden right region and drifted
  // the cluster ~125px off the composer (operator: "not hitting", 2026-06-15).
  // The composer card carries [data-composer-center]; track it through panel
  // resizes/animations (ResizeObserver — the card is maxWidth:100% so it
  // resizes as the column narrows) and remounts/tab-switches (MutationObserver,
  // rAF-debounced). Null → no composer (e.g. an Automations takeover) → fall
  // back to the column-width centering.
  const [composerCenterX, setComposerCenterX] = useState<number | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let raf = 0;
    let observed: Element | null = null;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => schedule()) : null;
    const measure = () => {
      const el = document.querySelector('[data-composer-center]');
      if (ro && el !== observed) {
        if (observed) ro.unobserve(observed);
        if (el) ro.observe(el);
        observed = el;
      }
      const rect = el?.getBoundingClientRect();
      const next = rect && rect.width > 0 ? Math.round(rect.left + rect.width / 2) : null;
      setComposerCenterX((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener('resize', schedule);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      mo.disconnect();
    };
  }, []);

  // Three-column footer that mirrors the dashboard layout above. Left section
  // takes the AgentPanel's exact width, right section takes the right-panel's
  // width (or 0 when hidden), so the center section spans the same horizontal
  // range as the workspace surface — and the merge cluster lands centered
  // directly under the chat / orchestrator.
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
      {/* The old left footer section (a leftColumnWidth-wide empty anchor) is
          GONE (2026-07-16): its utilities all moved out earlier that day
          (pair-mobile → account row, Canvas mode → workspace header, inbox +
          ports → branch capsule), and the bar itself now renders INSIDE the
          center+right column (dashboard layout), so the sidebar column runs
          full-height to the window bottom. The centre merge cluster keeps its
          position via the FIXED overlay below — viewport coords, same math as
          when the bar spanned the full window. */}

      {/* Flow spacer keeps the right-edge chrome (the ? button) pinned right.
          The branch/merge cluster itself is lifted into the absolute overlay
          below so it centers on the true workspace surface. */}
      <div style={{ flex: 1, minWidth: 0 }} />

      {/* Center cluster — absolutely centered on the true workspace surface
          (leftColumnWidth .. rightColumnWidth, the real widths, 0 when a panel
          is collapsed) so the branch/merge cluster sits dead-center under the
          composer and its chips in EVERY panel state, instead of drifting with
          the chrome-button section widths (operator: "they look cheap when they
          don't line up", 2026-06-15). pointerEvents:none lets clicks fall
          through the empty span; the cluster re-enables them. */}
      <div
        style={{
          // FIXED, not absolute (2026-07-16): the bar no longer spans the full
          // window (it lives inside the center+right column so the sidebar can
          // run full-height), but composerCenterX and the column-width
          // fallback are both VIEWPORT coordinates. Fixed keeps the original
          // math byte-for-byte; absolute would offset by the bar's new origin.
          position: 'fixed',
          bottom: 0,
          height: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          // Center on the composer's real measured center when present; else
          // fall back to the column-width span (takeovers with no composer).
          ...(composerCenterX != null
            ? { left: composerCenterX, transform: 'translateX(-50%)' }
            : { left: leftColumnWidth ?? 0, right: rightColumnWidth ?? 0 }),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'auto' }}>
          <MergeBeacon
            parked={parkedLanes}
            compact={compact}
            onOpenNeedsReviewLane={onOpenReviewLane}
            onOpenAwaitingMerge={onOpenAwaitingMerge}
          />
          <MergeActionCluster
            branchName={branchName}
            repoName={repoName}
            repoRemoteUrl={repoRemoteUrl}
            compact={compact}
          />
          {!compact && onToggleBottomPanel ? (
            <StatusBottomPanelControl
              active={bottomPanelVisible}
              onToggle={onToggleBottomPanel}
              onOpenSurface={onOpenBottomPanelSurface}
            />
          ) : null}
        </div>
      </div>

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
        {overrideActive ? (
          <ViewAsFreeIndicator palette="chrome" />
        ) : founder ? (
          <FoundingStatusBadge operatorNumber={founder.operatorNumber} />
        ) : null}
        {onOpenShortcuts ? <StatusShortcutsButton onClick={onOpenShortcuts} /> : null}
      </div>
    </div>
  );
}

export const DesktopStatusBar = memo(DesktopStatusBarBase);

/** Founding Operator mark — a hairline serial chip ("FOUNDING · 001") that sits
 *  beside the ? in the status bar, shown only to founders. The one founding
 *  orange (#ff5a1f, the founders-wall + edition color) marks the serial; the
 *  label reads through the chrome-flipped ink token so it works light + dark. */
const FOUNDER_ORANGE = '#ff5a1f';

function FoundingStatusBadge({ operatorNumber }: { operatorNumber: number }) {
  const serial = String(operatorNumber).padStart(3, '0');
  return (
    <div
      title={`Founding Operator · No. ${serial}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 22,
        paddingLeft: 9,
        paddingRight: 9,
        borderRadius: 6,
        background: 'rgba(255, 90, 31, 0.08)',
        borderWidth: '0.5px',
        borderStyle: 'solid',
        borderColor: 'rgba(255, 90, 31, 0.24)',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: '0.11em',
        textTransform: 'uppercase',
        color: 'var(--t-text-muted)',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span>Founding</span>
      <span style={{ color: 'var(--t-text-faint)', letterSpacing: 0 }}>·</span>
      <span
        style={{
          color: FOUNDER_ORANGE,
          letterSpacing: '0.04em',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {serial}
      </span>
    </div>
  );
}

const BOTTOM_PANEL_OPTIONS: Array<{
  id: BottomPanelSurfaceKind;
  label: string;
  detail: string;
  icon: (size?: number) => ReactNode;
}> = [
  { id: 'files', label: 'Files', detail: 'Browse project files', icon: (size = 14) => <FilesGlyph size={size} /> },
  { id: 'side-chat', label: 'Side chat', detail: 'Start a side conversation', icon: (size = 14) => <ChatGlyph size={size} /> },
  { id: 'browser', label: 'Browser', detail: 'Open a website', icon: (size = 14) => <BrowserGlyph size={size} /> },
  { id: 'review', label: 'Review', detail: 'View code changes', icon: (size = 14) => <ReviewGlyph size={size} /> },
  { id: 'terminal', label: 'Terminal', detail: 'Start an interactive shell', icon: (size = 14) => <TerminalGlyph size={size} /> },
];

/** Bottom panel control modeled after the Codex bottom-panel affordance:
 *  primary click toggles the drawer, chevron opens the surface picker. */
function StatusBottomPanelControl({
  active,
  onToggle,
  onOpenSurface,
}: {
  active: boolean;
  onToggle: () => void;
  onOpenSurface?: (surface: BottomPanelSurfaceKind) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Portaled popover (escapes the chrome-surface subtree so it inherits base
  // content tokens — dark ink on light glass — instead of the chrome flip's
  // white-on-transparent). Track its node + the anchor rect for positioning.
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  const openSurface = (surface: BottomPanelSurfaceKind) => {
    setMenuOpen(false);
    onOpenSurface?.(surface);
  };

  return (
    <div ref={menuRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          height: 26,
          borderRadius: 8,
          background: hovered || menuOpen ? 'var(--t-hover)' : 'transparent',
          color: active ? 'var(--t-accent)' : 'var(--t-text-secondary)',
          transition: 'background 120ms ease, color 120ms ease',
          overflow: 'hidden',
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label="Toggle bottom panel"
          title="Toggle bottom panel"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 26,
            borderWidth: 0,
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <TerminalGlyph size={14} />
        </button>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => {
            const next = !open;
            if (next && menuRef.current) setAnchorRect(menuRef.current.getBoundingClientRect());
            return next;
          })}
          aria-label="Choose bottom panel surface"
          title="Choose bottom panel surface"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 26,
            borderWidth: 0,
            borderLeft: '1px solid var(--t-divider-subtle)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      {menuOpen && anchorRect && typeof document !== 'undefined' ? createPortal((
        <div
          ref={popoverRef}
          role="menu"
          style={{
            position: 'fixed',
            bottom: typeof window !== 'undefined' ? window.innerHeight - anchorRect.top + 8 : 48,
            left: anchorRect.left + anchorRect.width / 2,
            transform: 'translateX(-50%)',
            width: 520,
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 8,
            padding: 10,
            borderRadius: 14,
            background: 'var(--t-panel-solid)',
            border: '1px solid var(--t-panel-border)',
            boxShadow: 'var(--t-panel-shadow), 0 18px 44px rgba(15, 23, 42, 0.20)',
            zIndex: 120,
          }}
        >
          {BOTTOM_PANEL_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitem"
              onClick={() => openSurface(option.id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                minHeight: 96,
                borderRadius: 10,
                border: '1px solid transparent',
                background: 'color-mix(in srgb, var(--t-panel) 70%, transparent)',
                color: 'var(--t-text)',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
                textAlign: 'center',
                padding: 10,
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--t-hover)';
                event.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'color-mix(in srgb, var(--t-panel) 70%, transparent)';
                event.currentTarget.style.borderColor = 'transparent';
              }}
            >
              <span style={{ color: 'var(--t-text-secondary)' }}>{option.icon(18)}</span>
              <span style={{ fontSize: 13, lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px' }}>{option.label}</span>
              <span style={{ fontSize: 9.5, lineHeight: 1.25, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-muted)' }}>{option.detail}</span>
            </button>
          ))}
        </div>
      ), document.body) : null}
    </div>
  );
}

function TerminalGlyph({ size = 14 }: { size?: number }) {
  // Tabler Terminal2 — operator-locked icon for the bottom-area
  // terminal affordance. See Hurttlocker.md§"Icon vocabulary".
  return <TablerTerminal size={size} strokeWidth={2} />;
}

// Locked Iconoir picks per hurttlocker.md — same set used in O8Panel's
// RightUtilityLauncher so both surfaces share an icon vocabulary.

function FilesGlyph({ size = 14 }: { size?: number }) {
  return <Folder width={size} height={size} color="currentColor" strokeWidth={1.6} />;
}

function ChatGlyph({ size = 14 }: { size?: number }) {
  return <CircleSpark width={size} height={size} color="currentColor" strokeWidth={1.6} />;
}

function BrowserGlyph({ size = 14 }: { size?: number }) {
  return <Internet width={size} height={size} color="currentColor" strokeWidth={1.6} />;
}

function ReviewGlyph({ size = 14 }: { size?: number }) {
  return <DoubleCheck width={size} height={size} color="currentColor" strokeWidth={1.6} />;
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
