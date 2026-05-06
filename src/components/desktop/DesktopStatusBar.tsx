'use client';

/**
 * DesktopStatusBar — 28px chrome strip pinned to the bottom of the dashboard.
 *
 * Mirrors the TitleBar pattern at the top (transparent background, neomorphic
 * buttons) but lives at the foot of the flex column.
 *
 *   [⚙] [🟢 N]  [+]                                  [⎇ branch-name]
 *     settings ports addRepo                         current branch
 *
 * Content migrated here from the retired NavRail (settings, ports, alerts
 * all used to live on the left side column). Every button uses the
 * shared ChromeButton so the style matches TitleBar + future WorkspaceTerminal
 * tabs.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Copy, Send } from './lucide-shims';
import { FolderPlus, GearSix, WarningCircle } from '@phosphor-icons/react';
import { ChromeButton } from './chrome/ChromeButton';
import { UpdateBanner } from './UpdateBanner';
import { MergeActionCluster } from './MergeActionCluster';

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
  onOpenSettings: () => void;
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
 *
 * Long-press / right-click on a port row swaps the popover to an action
 * panel with "Send to mobile" + "Copy URL" buttons (#782). Long-press
 * threshold is 500ms (matches mobile haptic conventions).
 */
const LONG_PRESS_MS = 500;

type ActionTarget = { port: number; url: string; repo: string };
type ActionToast = { tone: 'success' | 'error'; message: string } | null;

function FooterPorts({ onPortPreview }: { onPortPreview?: DesktopStatusBarProps['onPortPreview'] }) {
  const [groups, setGroups] = useState<PortGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);
  const [popoverLeft, setPopoverLeft] = useState(120);
  const [actionTarget, setActionTarget] = useState<ActionTarget | null>(null);
  const [actionToast, setActionToast] = useState<ActionToast>(null);
  const [sending, setSending] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const showActionToast = (toast: ActionToast) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setActionToast(toast);
    if (toast) {
      toastTimer.current = setTimeout(() => setActionToast(null), 2400);
    }
  };

  const enterActionMode = (target: ActionTarget) => {
    longPressFiredRef.current = true;
    setActionTarget(target);
    setActionToast(null);
  };

  const exitActionMode = () => {
    setActionTarget(null);
    setSending(false);
  };

  const sendToMobile = async (target: ActionTarget) => {
    if (sending) return;
    setSending(true);
    try {
      const response = await fetch('/api/mobile/push-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target.url, sourceRepoId: target.repo || null }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; recipients?: number; error?: string }
        | null;
      if (response.ok && payload?.ok) {
        const recipients = typeof payload.recipients === 'number' ? payload.recipients : 0;
        showActionToast(
          recipients > 0
            ? { tone: 'success', message: 'Sent to mobile' }
            : { tone: 'error', message: 'No phone connected' },
        );
      } else {
        const message = typeof payload?.error === 'string' && payload.error
          ? payload.error
          : 'Send failed';
        showActionToast({ tone: 'error', message });
      }
    } catch {
      showActionToast({ tone: 'error', message: 'Send failed' });
    } finally {
      setSending(false);
    }
  };

  const copyUrl = async (target: ActionTarget) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(target.url);
        showActionToast({ tone: 'success', message: 'Copied' });
      } else {
        showActionToast({ tone: 'error', message: 'Clipboard unavailable' });
      }
    } catch {
      showActionToast({ tone: 'error', message: 'Copy failed' });
    }
  };

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
    hideTimer.current = setTimeout(() => {
      setOpen(false);
      exitActionMode();
    }, 200);
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
          transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1)',
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
          {actionTarget ? (
            <PortActionPanel
              target={actionTarget}
              sending={sending}
              toast={actionToast}
              onSend={() => sendToMobile(actionTarget)}
              onCopy={() => copyUrl(actionTarget)}
              onBack={exitActionMode}
            />
          ) : null}
          {!actionTarget && allPorts.map(({ port, repo }) => (
            <button
              key={`${repo}-${port}`}
              type="button"
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (longPressTimer.current) {
                  clearTimeout(longPressTimer.current);
                  longPressTimer.current = null;
                }
                enterActionMode({ port, url: `http://localhost:${port}`, repo });
              }}
              onPointerDown={(event) => {
                if (event.pointerType === 'mouse' && event.button !== 0) return;
                longPressFiredRef.current = false;
                if (longPressTimer.current) clearTimeout(longPressTimer.current);
                longPressTimer.current = setTimeout(() => {
                  longPressTimer.current = null;
                  enterActionMode({ port, url: `http://localhost:${port}`, repo });
                }, LONG_PRESS_MS);
              }}
              onPointerUp={() => {
                if (longPressTimer.current) {
                  clearTimeout(longPressTimer.current);
                  longPressTimer.current = null;
                }
              }}
              onPointerLeave={() => {
                if (longPressTimer.current) {
                  clearTimeout(longPressTimer.current);
                  longPressTimer.current = null;
                }
              }}
              onPointerCancel={() => {
                if (longPressTimer.current) {
                  clearTimeout(longPressTimer.current);
                  longPressTimer.current = null;
                }
              }}
              onClick={() => {
                // Long-press already opened the action panel — don't also navigate.
                if (longPressFiredRef.current) {
                  longPressFiredRef.current = false;
                  return;
                }
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
                userSelect: 'none',
                WebkitUserSelect: 'none',
              }}
              title="Click to preview · Long-press or right-click for actions"
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

/**
 * Action panel shown inside the ports popover after a long-press / right-click
 * on a port row. Two actions: send the dev-host URL to the connected mobile
 * client (#782) or copy the URL to the clipboard. The inline toast clears
 * itself after ~2.4s.
 */
function PortActionPanel({
  target,
  sending,
  toast,
  onSend,
  onCopy,
  onBack,
}: {
  target: ActionTarget;
  sending: boolean;
  toast: ActionToast;
  onSend: () => void;
  onCopy: () => void;
  onBack: () => void;
}) {
  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    paddingTop: 4,
    paddingRight: 6,
    paddingBottom: 6,
    paddingLeft: 6,
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--t-text-faint)',
    letterSpacing: '-0.01em',
  } as const;

  const actionRowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    paddingTop: 7,
    paddingRight: 8,
    paddingBottom: 7,
    paddingLeft: 8,
    borderWidth: 0,
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--t-text)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
  };

  const toastTone = toast?.tone === 'success' ? '#16a34a' : '#dc2626';

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={headerStyle}>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to port list"
          title="Back"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 4,
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text-faint)',
            cursor: 'pointer',
            transform: 'scaleX(-1)',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          <ChevronRight size={11} strokeWidth={2} />
        </button>
        <span style={{ flex: 1 }}>{portLabel(target.port)}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--t-text-faint)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}
        >
          :{target.port}
        </span>
      </div>
      <button
        type="button"
        onClick={onSend}
        disabled={sending}
        style={{
          ...actionRowStyle,
          opacity: sending ? 0.6 : 1,
          cursor: sending ? 'progress' : 'pointer',
        }}
        onMouseEnter={(event) => {
          if (!sending) event.currentTarget.style.background = 'var(--t-panel-hover)';
        }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        <Send size={12} strokeWidth={1.8} />
        <span style={{ flex: 1 }}>{sending ? 'Sending…' : 'Send to mobile'}</span>
      </button>
      <button
        type="button"
        onClick={onCopy}
        style={actionRowStyle}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        <Copy size={12} strokeWidth={1.8} />
        <span style={{ flex: 1 }}>Copy URL</span>
      </button>
      <div
        style={{
          paddingTop: 4,
          paddingRight: 8,
          paddingBottom: 4,
          paddingLeft: 8,
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--t-text-faint)',
          fontFamily: '"SF Mono", ui-monospace, monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {target.url}
      </div>
      {toast ? (
        <div
          role="status"
          style={{
            paddingTop: 6,
            paddingRight: 8,
            paddingBottom: 6,
            paddingLeft: 8,
            marginTop: 2,
            fontSize: 11,
            fontWeight: 600,
            color: toastTone,
            letterSpacing: '-0.01em',
          }}
        >
          {toast.message}
        </div>
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
  const background = active ? 'var(--t-warning-soft, rgba(249,115,22,0.11))' : 'var(--t-chrome-btn-bg)';
  const chromeShadow = 'var(--t-chrome-btn-shadow)';
  const countBackground = active ? 'var(--t-warning, #f97316)' : 'transparent';
  const countColor = active ? '#ffffff' : 'var(--t-text-muted)';

  const openInboxTab = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:open-inbox-tab'));
  };

  return (
    <button
      type="button"
      onClick={openInboxTab}
      aria-label={`Supervisor inbox${active ? `, ${humanRequiredCount} human-required item${humanRequiredCount === 1 ? '' : 's'}` : ''}`}
      title={active ? `${humanRequiredCount} human-required inbox item${humanRequiredCount === 1 ? '' : 's'}` : 'Supervisor inbox'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 6,
        border: active ? `1px solid var(--t-warning-border, rgba(249,115,22,0.22))` : 'none',
        boxShadow: active ? 'none' : chromeShadow,
        background,
        color: active ? 'var(--t-warning, #c2410c)' : 'var(--t-chrome-btn-text, var(--t-text))',
        cursor: 'pointer',
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
    </button>
  );
}

function DesktopStatusBarBase({
  branchName,
  repoName,
  repoRemoteUrl = null,
  leftColumnWidth,
  rightColumnWidth,
  onOpenSettings,
  onAddRepo,
  onPortPreview,
}: DesktopStatusBarProps) {
  // Three-column footer that mirrors the dashboard layout above. Left section
  // takes the AgentPanel's exact width, right section takes the right-panel's
  // width (or 0 when hidden), so the center section spans the same horizontal
  // range as the workspace surface — and the merge cluster lands centered
  // directly under the chat / orchestrator.
  return (
    <div
      data-mcp-scope="desktop-status-bar"
      data-chrome-surface="true"
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
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      <div
        style={{
          width: leftColumnWidth,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 12,
          paddingRight: 12,
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
          icon={<FolderPlus size={14} weight="bold" color="var(--t-text)" />}
          label="Add repository"
          onClick={onAddRepo}
          size={22}
          radius={6}
        />
        <FooterPorts onPortPreview={onPortPreview} />
        <SupervisorInboxBadge />
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <MergeActionCluster
          branchName={branchName}
          repoName={repoName}
          repoRemoteUrl={repoRemoteUrl}
        />
      </div>

      <div
        style={{
          width: rightColumnWidth ?? undefined,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingLeft: 12,
          paddingRight: 12,
          gap: 6,
        }}
      >
        <UpdateBanner />
      </div>
    </div>
  );
}

export const DesktopStatusBar = memo(DesktopStatusBarBase);
