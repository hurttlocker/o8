'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Copy, Send } from '../lucide-shims';
import { Internet, Server as ServerIcon } from 'iconoir-react';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { safeCancelIdleCallback, safeRequestIdleCallback, type SafeIdleCallbackHandle } from '@/lib/util/webview-safe';
import { useWsConnectionState } from '../hooks/DesktopWebSocketContext';

type PortKind = 'page' | 'service';

interface PortEntry {
  port: number;
  repo: string | null;
  process: string;
  /** Human label from the server ("Next.js", "Vite", "Python http.server", …). */
  label: string;
  /** page = openable web page · service = background listener (informational). */
  kind: PortKind;
}

/**
 * Inline footer-anchored dev-server launcher. Polls `/api/panel/ports` (now
 * server-classified into `page` vs `service`) and refreshes on agent-lifecycle
 * events. The popover is a launcher, not a port dump:
 *   - Pages    → local dev servers that answered with a web page. Click opens
 *                them in o8's embedded browser (`onPortPreview`). Long-press /
 *                right-click swaps to a "Send to mobile · Copy URL" panel (#782).
 *   - Services → background listeners (DBs, APIs, MCP bridges). Collapsed behind
 *                an "N more services" toggle, informational only — no click.
 * The footer badge counts PAGES. o8's own ports never appear (filtered server-side).
 */
const LONG_PRESS_MS = 500;

type ActionTarget = { port: number; url: string; repo: string; label: string };
type ActionToast = { tone: 'success' | 'error'; message: string } | null;

type FooterPortsOnPortPreview = (port: number, url: string, repo?: string) => void;

// 44px min-height per Apple HIG — a generous click target for opening a dev server.
const PAGE_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  width: '100%',
  minHeight: 44,
  paddingTop: 6,
  paddingRight: 8,
  paddingBottom: 6,
  paddingLeft: 10,
  borderWidth: 0,
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--t-text)',
  fontSize: 13.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.25,
  cursor: 'pointer',
  textAlign: 'left' as const,
  fontFamily: 'var(--font-sans-system)',
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
} as const;

const SERVICE_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  paddingTop: 5,
  paddingRight: 8,
  paddingBottom: 5,
  paddingLeft: 10,
  borderRadius: 6,
  color: 'var(--t-text-faint)',
  fontSize: 12,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.25,
  fontFamily: 'var(--font-sans-system)',
} as const;

const PORT_NUM_STYLE = {
  fontSize: 9.5,
  fontWeight: 300,
  letterSpacing: '-0.2px',
  color: 'var(--t-text-faint)',
  fontFamily: '"SF Mono", ui-monospace, monospace',
} as const;

export function FooterPorts({ onPortPreview }: { onPortPreview?: FooterPortsOnPortPreview }) {
  const [ports, setPorts] = useState<PortEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [servicesExpanded, setServicesExpanded] = useState(false);
  const [popoverLeft, setPopoverLeft] = useState(120);
  const [actionTarget, setActionTarget] = useState<ActionTarget | null>(null);
  const [actionToast, setActionToast] = useState<ActionToast>(null);
  const [sending, setSending] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const wsConnected = useWsConnectionState() === 'connected';

  useEffect(() => {
    let cancelled = false;
    function fetchPorts() {
      fetch('/api/panel/ports')
        .then((r) => r.json())
        .then((data: { ports?: PortEntry[] }) => {
          if (cancelled) return;
          setPorts(data.ports ?? []);
        })
        .catch(() => {});
    }
    let rICHandle: SafeIdleCallbackHandle | undefined;
    let timeoutHandle: number | undefined;
    rICHandle = safeRequestIdleCallback(() => {
      rICHandle = undefined;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      fetchPorts();
    }, { timeout: 3000, fallbackDelayMs: 1500 });
    timeoutHandle = window.setTimeout(() => {
      timeoutHandle = undefined;
      if (rICHandle !== undefined) safeCancelIdleCallback(rICHandle);
      rICHandle = undefined;
      fetchPorts();
    }, 1500);
    const handler = () => fetchPorts();
    window.addEventListener('o8:agent-lifecycle', handler);
    // Socket bridges agent-lifecycle into this window event; the interval is a
    // safety net (slower when the socket is live, faster when it's down so we
    // don't go blind). Reconnecting refetches immediately (wsConnected in deps).
    const fallback = setInterval(fetchPorts, wsConnected ? 60_000 : 20_000);
    return () => {
      cancelled = true;
      if (rICHandle !== undefined) safeCancelIdleCallback(rICHandle);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      clearInterval(fallback);
      window.removeEventListener('o8:agent-lifecycle', handler);
    };
  }, [wsConnected]);

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

  // ── Buckets ──
  const pages = ports.filter((p) => p.kind === 'page');
  const services = ports.filter((p) => p.kind === 'service');

  if (pages.length === 0 && services.length === 0) return null;

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

  const hasPages = pages.length > 0;
  const ariaLabel = hasPages
    ? `${pages.length} local dev server${pages.length === 1 ? '' : 's'}`
    : 'No local dev servers';

  // ── Row renderers ──
  const renderPageRow = (p: PortEntry) => {
    const url = `http://localhost:${p.port}`;
    const repo = p.repo ?? '';
    return (
      <button
        key={`page-${repo}-${p.port}`}
        type="button"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
          enterActionMode({ port: p.port, url, repo, label: p.label });
        }}
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          longPressFiredRef.current = false;
          if (longPressTimer.current) clearTimeout(longPressTimer.current);
          longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            enterActionMode({ port: p.port, url, repo, label: p.label });
          }, LONG_PRESS_MS);
        }}
        onPointerUp={() => {
          if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
        }}
        onPointerLeave={() => {
          if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
        }}
        onPointerCancel={() => {
          if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
        }}
        onClick={() => {
          if (longPressFiredRef.current) { longPressFiredRef.current = false; return; }
          setOpen(false);
          if (onPortPreview) onPortPreview(p.port, url, repo || undefined);
          else openExternalUrl(url);
        }}
        style={PAGE_ROW_STYLE}
        title="Click to open in browser · Long-press or right-click for actions"
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        <Internet width={14} height={14} color="var(--t-success)" strokeWidth={2} style={{ flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
          {repo ? (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 300,
                color: 'var(--t-text-faint)',
                letterSpacing: '-0.1px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {repo}
            </span>
          ) : null}
        </span>
        <span style={PORT_NUM_STYLE}>:{p.port}</span>
      </button>
    );
  };

  const renderServiceRow = (p: PortEntry) => (
    <div key={`svc-${p.repo ?? ''}-${p.port}`} style={SERVICE_ROW_STYLE}>
      <ServerIcon width={12} height={12} color="var(--t-text-faint)" strokeWidth={2} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p.label}{p.repo ? ` · ${p.repo}` : ''}
      </span>
      <span style={PORT_NUM_STYLE}>:{p.port}</span>
    </div>
  );

  return (
    <div
      data-footer-ports=""
      ref={anchorRef}
      onMouseEnter={showPopover}
      onMouseLeave={scheduleHide}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        title={ariaLabel}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 36,
          height: 26,
          paddingLeft: 7,
          paddingRight: 7,
          borderRadius: 7,
          borderWidth: 0,
          flexShrink: 0,
          background: hasPages ? 'var(--t-success-soft)' : 'var(--t-panel-hover)',
          color: hasPages ? 'var(--t-success)' : 'var(--t-text-faint)',
          fontSize: 11,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          fontFamily: '"SF Mono", ui-monospace, monospace',
          cursor: 'pointer',
          lineHeight: 1,
          whiteSpace: 'nowrap',
          transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onClick={() => setOpen((v) => !v)}
      >
        {hasPages ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Internet width={12} height={12} color="var(--t-success)" strokeWidth={2} />
            {pages.length}
          </span>
        ) : (
          <Internet width={13} height={13} color="var(--t-text-faint)" strokeWidth={2} />
        )}
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          data-stationary-chrome="true"
          onMouseEnter={showPopover}
          onMouseLeave={scheduleHide}
          style={{
            position: 'fixed',
            bottom: 48,
            left: popoverLeft,
            minWidth: 220,
            maxWidth: 320,
            padding: 6,
            borderRadius: 12,
            background: 'var(--t-panel-solid)',
            border: '1px solid var(--t-panel-border)',
            boxShadow: 'var(--t-panel-shadow)',
            zIndex: 9999,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          <div
            style={{
              paddingTop: 4,
              paddingRight: 8,
              paddingBottom: 6,
              paddingLeft: 10,
              fontSize: 10,
              fontWeight: 300,
              color: 'var(--t-text-faint)',
              letterSpacing: '-0.1px',
            }}
          >
            {hasPages
              ? `${pages.length} local dev server${pages.length === 1 ? '' : 's'}`
              : 'Local dev servers'}
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
          ) : (
            <>
              {hasPages ? (
                pages.map(renderPageRow)
              ) : (
                <div
                  style={{
                    paddingTop: 8,
                    paddingRight: 10,
                    paddingBottom: 10,
                    paddingLeft: 10,
                    fontSize: 12.5,
                    fontWeight: 300,
                    color: 'var(--t-text-faint)',
                    letterSpacing: '-0.1px',
                    lineHeight: 1.3,
                  }}
                >
                  No local dev servers
                </div>
              )}
              {services.length > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={() => setServicesExpanded((v) => !v)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      marginTop: hasPages ? 4 : 2,
                      paddingTop: 5,
                      paddingRight: 8,
                      paddingBottom: 5,
                      paddingLeft: 10,
                      borderWidth: 0,
                      borderRadius: 6,
                      background: 'transparent',
                      color: 'var(--t-text-faint)',
                      fontSize: 11,
                      fontWeight: 300,
                      letterSpacing: '-0.1px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'var(--font-sans-system)',
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        transform: servicesExpanded ? 'rotate(90deg)' : 'none',
                        transition: 'transform 120ms ease',
                      }}
                    >
                      <ChevronRight size={10} strokeWidth={2} />
                    </span>
                    <span style={{ flex: 1 }}>
                      {services.length} more service{services.length === 1 ? '' : 's'}
                    </span>
                  </button>
                  {servicesExpanded ? services.map(renderServiceRow) : null}
                </>
              ) : null}
            </>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

/**
 * Action panel shown inside the launcher after a long-press / right-click on a
 * dev-server row. Two actions: send the dev-host URL to the connected mobile
 * client (#782) or copy the URL. The inline toast clears itself after ~2.4s.
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
    fontSize: 12,
    fontWeight: 300,
    color: 'var(--t-text)',
    letterSpacing: '-0.1px',
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
    fontWeight: 300,
    letterSpacing: '-0.1px',
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontFamily: 'var(--font-sans-system)',
  };

  const toastTone = toast?.tone === 'success' ? 'var(--t-success)' : 'var(--t-danger)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={headerStyle}>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to dev server list"
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
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{target.label}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 300,
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
          fontWeight: 300,
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
            fontWeight: 300,
            color: toastTone,
            letterSpacing: '-0.1px',
          }}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}
