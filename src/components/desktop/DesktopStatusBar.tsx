'use client';

/**
 * DesktopStatusBar — 28px chrome strip pinned to the bottom of the dashboard.
 *
 * Mirrors the TitleBar pattern at the top (transparent background, neomorphic
 * buttons) but lives at the foot of the flex column.
 *
 *   [⚙] [📊] [🟢 N]  [+]                             [⎇ branch-name]
 *     settings analytics ports addRepo               current branch
 *
 * Content migrated here from the retired NavRail (settings, analytics, ports,
 * alerts all used to live on the left side column). Every button uses the
 * shared ChromeButton so the style matches TitleBar + future WorkspaceTerminal
 * tabs.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch } from './lucide-shims';
import { ChartBar, FolderPlus, GearSix, WarningCircle } from '@phosphor-icons/react';
import { ChromeButton } from './chrome/ChromeButton';
import { formatBranchDisplayName } from './repo-registry/shared';

interface DesktopStatusBarProps {
  branchName: string | null;
  repoName: string | null;
  isAnalyticsSectionActive?: boolean;
  onOpenSettings: () => void;
  onOpenAnalytics: () => void;
  onAddRepo: () => void;
  onPortPreview?: (port: number, url: string, repo?: string) => void;
}

interface PortGroup {
  repo: string;
  repoPath: string;
  ports: number[];
}

const WELL_KNOWN_PORTS: Record<number, string> = {
  3000: 'Dev server',
  3001: 'Dev server',
  3002: 'WebSocket',
  8080: 'Dev server',
};

function portLabel(port: number): string {
  return WELL_KNOWN_PORTS[port] ?? `Port ${port}`;
}

/**
 * Inline footer-anchored version of the old NavRail PortsFooter — polls the
 * same `/api/panel/ports` endpoint and refreshes on agent-lifecycle events.
 * The popover opens upward from the footer button.
 */
function FooterPorts({ onPortPreview }: { onPortPreview?: DesktopStatusBarProps['onPortPreview'] }) {
  const [groups, setGroups] = useState<PortGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);
  const [popoverLeft, setPopoverLeft] = useState(120);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    function fetchPorts() {
      fetch('/api/panel/ports')
        .then((r) => r.json())
        .then((data: { groups?: PortGroup[]; total?: number }) => {
          if (cancelled) return;
          setGroups(data.groups ?? []);
          setTotal(data.total ?? 0);
        })
        .catch(() => {});
    }
    fetchPorts();
    const handler = () => fetchPorts();
    window.addEventListener('o8:agent-lifecycle', handler);
    const fallback = setInterval(fetchPorts, 120_000);
    return () => {
      cancelled = true;
      clearInterval(fallback);
      window.removeEventListener('o8:agent-lifecycle', handler);
    };
  }, []);

  if (total === 0) return null;

  const showPopover = () => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPopoverLeft(Math.max(8, rect.left - 4));
    }
    setOpen(true);
  };
  const scheduleHide = () => {
    hideTimer.current = setTimeout(() => setOpen(false), 200);
  };

  const ariaLabel = `${total} active port${total === 1 ? '' : 's'}`;
  const allPorts = groups.flatMap((g) => g.ports.map((p) => ({ port: p, repo: g.repo })));

  return (
    <div
      ref={anchorRef}
      onMouseEnter={showPopover}
      onMouseLeave={scheduleHide}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        title={ariaLabel}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 24,
          height: 18,
          paddingLeft: 6,
          paddingRight: 6,
          borderRadius: 6,
          borderWidth: 0,
          background: 'rgba(34,197,94,0.1)',
          color: '#16a34a',
          fontSize: 10,
          fontWeight: 700,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          cursor: 'pointer',
          transition: 'background 140ms ease',
        }}
        onClick={() => setOpen((v) => !v)}
      >
        {total} port{total === 1 ? '' : 's'}
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          onMouseEnter={showPopover}
          onMouseLeave={scheduleHide}
          style={{
            position: 'fixed',
            bottom: 36, // above the 28px status bar + small gap
            left: popoverLeft,
            minWidth: 200,
            padding: 6,
            borderRadius: 12,
            background: 'var(--t-panel-solid)',
            border: '1px solid var(--t-panel-border)',
            boxShadow: 'var(--t-panel-shadow), 0 8px 24px rgba(15, 23, 42, 0.18)',
            zIndex: 9999,
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          <div
            style={{
              paddingTop: 4,
              paddingRight: 8,
              paddingBottom: 6,
              paddingLeft: 8,
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--t-text-faint)',
              letterSpacing: '-0.01em',
            }}
          >
            {total} active port{total === 1 ? '' : 's'}
          </div>
          {allPorts.map(({ port, repo }) => (
            <button
              key={`${repo}-${port}`}
              type="button"
              onClick={() => {
                setOpen(false);
                const url = `http://localhost:${port}`;
                if (onPortPreview) {
                  onPortPreview(port, url, repo);
                } else {
                  window.open(url, '_blank');
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                paddingTop: 6,
                paddingRight: 8,
                paddingBottom: 6,
                paddingLeft: 8,
                borderWidth: 0,
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--t-text)',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
              onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  background: '#22c55e',
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1 }}>{portLabel(port)}</span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--t-text-faint)',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                }}
              >
                :{port}
              </span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function SupervisorInboxBadge() {
  const [humanRequiredCount, setHumanRequiredCount] = useState(0);

  useEffect(() => {
    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ data?: { humanRequiredCount?: unknown } }>).detail;
      const nextCount = detail?.data?.humanRequiredCount;
      if (typeof nextCount === 'number' && Number.isFinite(nextCount)) {
        setHumanRequiredCount(Math.max(0, Math.floor(nextCount)));
      }
    };

    window.addEventListener('o8:supervisor-inbox', handleUpdate);
    return () => {
      window.removeEventListener('o8:supervisor-inbox', handleUpdate);
    };
  }, []);

  const active = humanRequiredCount > 0;
  const borderColor = active ? 'rgba(249,115,22,0.2)' : 'rgba(148,163,184,0.16)';
  const background = active ? 'rgba(249,115,22,0.11)' : 'rgba(255,255,255,0.42)';
  const countBackground = active ? '#f97316' : 'rgba(148,163,184,0.18)';
  const countColor = active ? '#fff7ed' : 'var(--t-text-faint)';

  return (
    <a
      href="/dashboard/inbox"
      aria-label={`Supervisor inbox${active ? `, ${humanRequiredCount} human-required item${humanRequiredCount === 1 ? '' : 's'}` : ''}`}
      title={active ? `${humanRequiredCount} human-required inbox item${humanRequiredCount === 1 ? '' : 's'}` : 'Supervisor inbox'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 18,
        paddingLeft: 7,
        paddingRight: 7,
        borderRadius: 9,
        textDecoration: 'none',
        border: `1px solid ${borderColor}`,
        background,
        color: active ? '#c2410c' : 'var(--t-text-faint)',
        boxShadow: active ? '0 8px 20px rgba(249, 115, 22, 0.12)' : 'none',
        transition: 'background 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      <WarningCircle size={11} weight={active ? 'fill' : 'bold'} />
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '-0.01em',
        }}
      >
        Inbox
      </span>
      <span
        style={{
          minWidth: 14,
          height: 14,
          paddingLeft: 4,
          paddingRight: 4,
          borderRadius: 7,
          background: countBackground,
          color: countColor,
          fontSize: 9,
          fontWeight: 800,
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {humanRequiredCount > 99 ? '99+' : humanRequiredCount}
      </span>
    </a>
  );
}

function DesktopStatusBarBase({
  branchName,
  repoName,
  isAnalyticsSectionActive = false,
  onOpenSettings,
  onOpenAnalytics,
  onAddRepo,
  onPortPreview,
}: DesktopStatusBarProps) {
  const displayBranch = branchName ? formatBranchDisplayName(branchName) : null;
  const tooltip = branchName
    ? repoName
      ? `${repoName} · ${branchName}`
      : branchName
    : null;

  return (
    <div
      data-mcp-scope="desktop-status-bar"
      data-chrome-surface="true"
      style={{
        height: 28,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 0,
        paddingRight: 12,
        paddingBottom: 0,
        paddingLeft: 12,
        background: 'transparent',
        // No top border — blends into the panel above.
        borderTopWidth: 0,
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      <ChromeButton
        icon={<GearSix size={14} weight="bold" color="var(--t-text)" />}
        label="Settings"
        onClick={onOpenSettings}
        size={22}
        radius={6}
      />
      <ChromeButton
        icon={<ChartBar size={14} weight={isAnalyticsSectionActive ? 'fill' : 'bold'} color={isAnalyticsSectionActive ? 'var(--t-accent)' : 'var(--t-text)'} />}
        label="Analytics"
        onClick={onOpenAnalytics}
        active={isAnalyticsSectionActive}
        size={22}
        radius={6}
      />
      <ChromeButton
        icon={<FolderPlus size={14} weight="bold" color="var(--t-text)" />}
        label="Add repository"
        onClick={onAddRepo}
        size={22}
        radius={6}
      />
      <FooterPorts onPortPreview={onPortPreview} />
      <SupervisorInboxBadge />

      <div style={{ flex: 1 }} />

      {displayBranch ? (
        <span
          title={tooltip ?? undefined}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            fontWeight: 440,
            color: 'var(--t-text-faint)',
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
            maxWidth: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <GitBranch size={11} strokeWidth={1.8} />
          {displayBranch}
        </span>
      ) : null}
    </div>
  );
}

export const DesktopStatusBar = memo(DesktopStatusBarBase);
