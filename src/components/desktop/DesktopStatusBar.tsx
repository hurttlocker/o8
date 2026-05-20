'use client';

/**
 * DesktopStatusBar — compact chrome strip pinned to the bottom of the dashboard.
 *
 * Mirrors the compact TitleBar controls at the top but lives at the foot of
 * the flex column.
 *
 *   [⚙] [🟢 N]  [+]                                  [⎇ branch-name]
 *     settings ports addRepo                         current branch
 *
 * Content migrated here from the retired NavRail (settings, ports, alerts
 * all used to live on the left side column). Every button uses the
 * shared ChromeButton so the style matches TitleBar + future WorkspaceTerminal
 * tabs.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FolderPlus, GearSix } from '@phosphor-icons/react';
import { Smartphone } from './lucide-shims';
import { ChromeButton } from './chrome/ChromeButton';
import { MergeActionCluster, type MergePreviewVariant } from './MergeActionCluster';
import { FooterPorts } from './desktop-status-bar/footer-ports';
import { SupervisorInboxBadge } from './desktop-status-bar/supervisor-inbox-badge';
import { SettingsQuickDrawer } from './SettingsQuickDrawer';

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
  /** Narrow desktop mode: keep only durable, terminal-like status chrome. */
  compact?: boolean;
  onOpenSettings: () => void;
  onAddRepo: () => void;
  /** Open the full-screen mobile-pairing QR view (a canvas tab). */
  onOpenMobilePairing: () => void;
  onPortPreview?: (port: number, url: string, repo?: string) => void;
  /** Contextual bottom-panel (terminal) toggle. Moved from the column
   *  header per operator request — sits in the status bar's center
   *  column next to the branch label. */
  bottomPanelVisible?: boolean;
  onToggleBottomPanel?: () => void;
}

function DesktopStatusBarBase({
  branchName,
  repoName,
  repoRemoteUrl = null,
  bottomPanelVisible = false,
  onToggleBottomPanel,
  leftColumnWidth,
  rightColumnWidth,
  compact = false,
  onOpenSettings,
  onAddRepo,
  onOpenMobilePairing,
  onPortPreview,
}: DesktopStatusBarProps) {
  const settingsButtonRef = useRef<HTMLDivElement | null>(null);
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  const [settingsAnchorRect, setSettingsAnchorRect] = useState<DOMRect | null>(null);

  const syncSettingsAnchor = useCallback(() => {
    setSettingsAnchorRect(settingsButtonRef.current?.getBoundingClientRect() ?? null);
  }, []);

  const toggleSettingsDrawer = useCallback(() => {
    syncSettingsAnchor();
    setSettingsDrawerOpen((open) => !open);
  }, [syncSettingsAnchor]);

  const closeSettingsDrawer = useCallback(() => {
    setSettingsDrawerOpen(false);
  }, []);

  const openFullSettings = useCallback(() => {
    setSettingsDrawerOpen(false);
    onOpenSettings();
  }, [onOpenSettings]);

  useEffect(() => {
    if (!settingsDrawerOpen) return;
    window.addEventListener('resize', syncSettingsAnchor);
    window.addEventListener('scroll', syncSettingsAnchor, true);
    return () => {
      window.removeEventListener('resize', syncSettingsAnchor);
      window.removeEventListener('scroll', syncSettingsAnchor, true);
    };
  }, [settingsDrawerOpen, syncSettingsAnchor]);

  // Dev preview override for MergeActionCluster — operator cycles through
  // the merge-pill states from main without needing a real PR. Initial
  // state MUST be 'auto' to match SSR; we read localStorage AFTER mount
  // in an effect to avoid a hydration mismatch that regenerates the
  // entire React tree (which silently breaks unrelated surfaces like
  // the left rail's chat list).
  const PREVIEW_STORAGE_KEY = 'o8:merge-preview-variant';
  const PREVIEW_CYCLE: MergePreviewVariant[] = ['auto', 'idle', 'open', 'view-pending', 'view-fail', 'merge-ready'];
  const [mergePreview, setMergePreview] = useState<MergePreviewVariant>('auto');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(PREVIEW_STORAGE_KEY);
    if (stored && PREVIEW_CYCLE.includes(stored as MergePreviewVariant)) {
      setMergePreview(stored as MergePreviewVariant);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cycleMergePreview = useCallback(() => {
    setMergePreview((current) => {
      const idx = PREVIEW_CYCLE.indexOf(current);
      const next = PREVIEW_CYCLE[(idx + 1) % PREVIEW_CYCLE.length];
      if (typeof window !== 'undefined') window.localStorage.setItem(PREVIEW_STORAGE_KEY, next);
      return next;
    });
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
        height: 28,
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
      }}
    >
      <div
        style={{
          width: compact ? 'auto' : leftColumnWidth,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 12,
          paddingRight: 12,
          overflow: 'hidden',
          transform: 'translateY(-8px)',
        }}
      >
        <div ref={settingsButtonRef} style={{ display: 'flex', alignItems: 'center' }}>
          <ChromeButton
            icon={<GearSix size={15} weight="bold" color="var(--t-text)" />}
            label="Settings"
            active={settingsDrawerOpen}
            onClick={toggleSettingsDrawer}
            size={28}
            radius={8}
          />
        </div>
        <SettingsQuickDrawer
          open={settingsDrawerOpen}
          anchorRect={settingsAnchorRect}
          onClose={closeSettingsDrawer}
          onOpenSettings={openFullSettings}
        />
        {!compact ? (
          <>
            <ChromeButton
              icon={<Smartphone size={15} />}
              label="Pair mobile device"
              onClick={onOpenMobilePairing}
              size={28}
              radius={8}
            />
            <ChromeButton
              icon={<FolderPlus size={15} weight="bold" color="var(--t-text)" />}
              label="Add repository"
              onClick={onAddRepo}
              size={28}
              radius={8}
            />
            <FooterPorts onPortPreview={onPortPreview} />
            <SupervisorInboxBadge />
          </>
        ) : null}
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <MergeActionCluster
          branchName={branchName}
          repoName={repoName}
          repoRemoteUrl={repoRemoteUrl}
          previewVariant={mergePreview}
        />
        {onToggleBottomPanel ? (
          <StatusTerminalToggle
            active={bottomPanelVisible}
            onClick={onToggleBottomPanel}
          />
        ) : null}
        <MergePreviewCycler variant={mergePreview} onCycle={cycleMergePreview} />
      </div>

      <div
        style={{
          width: compact ? 0 : (rightColumnWidth ?? undefined),
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingLeft: 12,
          paddingRight: 12,
          gap: 6,
        }}
      >
      </div>
    </div>
  );
}

export const DesktopStatusBar = memo(DesktopStatusBarBase);

/** Dev cycler — small eye-style button that flips MergeActionCluster
 *  through its visual states from main, so the operator can fine-tune
 *  the pill look without standing up a real PR. Persists across reloads
 *  via localStorage. */
function MergePreviewCycler({ variant, onCycle }: { variant: MergePreviewVariant; onCycle: () => void }) {
  const [hovered, setHovered] = useState(false);
  const isActive = variant !== 'auto';
  const label: Record<MergePreviewVariant, string> = {
    auto: 'live',
    idle: 'idle',
    open: 'open',
    'view-pending': 'pending',
    'view-fail': 'fail',
    'merge-ready': 'ready',
  };
  return (
    <button
      type="button"
      onClick={onCycle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`Preview merge state — ${label[variant]}. Click to cycle.`}
      title={`Merge preview: ${label[variant]} — click to cycle`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 20,
        paddingLeft: 6,
        paddingRight: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: isActive ? 'var(--t-accent-border, rgba(37, 99, 235, 0.3))' : 'transparent',
        background: isActive
          ? 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))'
          : hovered
            ? 'var(--t-hover)'
            : 'transparent',
        color: isActive ? 'var(--t-accent)' : 'var(--t-text-faint)',
        cursor: 'pointer',
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
      }}
    >
      {label[variant]}
    </button>
  );
}

/** Terminal toggle pill that lives alongside the branch label in the
 *  status bar's center column. Chrome-less by design — just the icon,
 *  hover tints the background. Operator wanted it down here next to
 *  "main" rather than floating mid-workspace. */
function StatusTerminalToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="Toggle terminal"
      title="Toggle terminal"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 0,
        background: hovered ? 'var(--t-hover)' : 'transparent',
        color: active ? 'var(--t-accent)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m4 17 6-6-6-6" />
        <line x1="12" x2="20" y1="19" y2="19" />
      </svg>
    </button>
  );
}
