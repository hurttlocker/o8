'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Copy, Send } from '../lucide-shims';
import { Internet, Terminal as TerminalIcon, Database } from 'iconoir-react';
import { openExternalUrl } from '@/lib/desktop/open-external';

type PortCategory = 'agent' | 'browser' | 'noise';

interface PortEntry {
  port: number;
  repo: string | null;
  process: string;
  category: PortCategory;
  agentSession: string | null;
}

interface ManagedRun {
  id: string;
  session: string;
  command: string;
  status: 'running' | 'finished' | 'gone';
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
 * Inline footer-anchored ports indicator. Polls `/api/panel/ports` (now tagged
 * agent / browser / noise) plus `/api/panel/managed-runs` (portless `o8 run`
 * jobs), and refreshes on agent-lifecycle events. The popover opens upward and
 * splits ports into three buckets:
 *   - Agent  → o8-owned `o8 run` sessions; click opens a live read-only terminal
 *   - Browser→ the operator's dev servers; click previews the URL
 *   - Noise  → db/infra ports, collapsed by default
 *
 * Long-press / right-click on a port row swaps the popover to an action panel
 * with "Send to mobile" + "Copy URL" (#782). Long-press threshold is 500ms.
 */
const LONG_PRESS_MS = 500;

type ActionTarget = { port: number; url: string; repo: string };
type ActionToast = { tone: 'success' | 'error'; message: string } | null;

type FooterPortsOnPortPreview = (port: number, url: string, repo?: string) => void;

const PORT_ROW_STYLE = {
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
  fontSize: 13.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.25,
  cursor: 'pointer',
  textAlign: 'left' as const,
  fontFamily: 'var(--font-sans-system)',
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
};

const PORT_NUM_STYLE = {
  fontSize: 9.5,
  fontWeight: 260,
  letterSpacing: '-0.2px',
  color: 'var(--t-text-faint)',
  fontFamily: '"SF Mono", ui-monospace, monospace',
} as const;

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        paddingTop: 5,
        paddingRight: 8,
        paddingBottom: 2,
        paddingLeft: 8,
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
        color: 'var(--t-text-faint)',
      }}
    >
      {children}
    </div>
  );
}

export function FooterPorts({ onPortPreview }: { onPortPreview?: FooterPortsOnPortPreview }) {
  const [ports, setPorts] = useState<PortEntry[]>([]);
  const [runs, setRuns] = useState<ManagedRun[]>([]);
  const [open, setOpen] = useState(false);
  const [noiseExpanded, setNoiseExpanded] = useState(false);
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
    function fetchAll() {
      fetch('/api/panel/ports')
        .then((r) => r.json())
        .then((data: { ports?: PortEntry[] }) => {
          if (cancelled) return;
          setPorts(data.ports ?? []);
        })
        .catch(() => {});
      fetch('/api/panel/managed-runs')
        .then((r) => r.json())
        .then((data: { runs?: ManagedRun[] }) => {
          if (cancelled) return;
          setRuns(data.runs ?? []);
        })
        .catch(() => {});
    }
    fetchAll();
    const handler = () => fetchAll();
    window.addEventListener('o8:agent-lifecycle', handler);
    const fallback = setInterval(fetchAll, 20_000);
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

  // ── Buckets ──
  const agentPorts = ports.filter((p) => p.category === 'agent');
  const browserPorts = ports.filter((p) => p.category === 'browser');
  const noisePorts = ports.filter((p) => p.category === 'noise');
  const agentPortSessions = new Set(agentPorts.map((p) => p.agentSession).filter(Boolean));
  const portlessRuns = runs.filter((r) => r.status === 'running' && !agentPortSessions.has(r.session));
  const agentCount = agentPorts.length + portlessRuns.length;
  const displayTotal = ports.length + portlessRuns.length;
  const bucketsPresent =
    (agentCount > 0 ? 1 : 0) + (browserPorts.length > 0 ? 1 : 0) + (noisePorts.length > 0 ? 1 : 0);
  const showLabels = bucketsPresent > 1;

  if (displayTotal === 0) return null;

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

  const ariaLabel = `${displayTotal} active port${displayTotal === 1 ? '' : 's'}`;
  const compactTotal = displayTotal > 99 ? '99+' : String(displayTotal);

  // ── Row renderers (close over long-press refs + handlers) ──
  const renderPortButton = (p: PortEntry) => {
    const url = `http://localhost:${p.port}`;
    const repo = p.repo ?? '';
    const isAgent = p.category === 'agent';
    const isNoise = p.category === 'noise';
    const Glyph = isAgent ? TerminalIcon : isNoise ? Database : Internet;
    const accent = isAgent ? 'var(--t-accent)' : isNoise ? 'var(--t-text-faint)' : 'var(--t-success)';
    return (
      <button
        key={`${p.category}-${repo}-${p.port}`}
        type="button"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
          enterActionMode({ port: p.port, url, repo });
        }}
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) return;
          longPressFiredRef.current = false;
          if (longPressTimer.current) clearTimeout(longPressTimer.current);
          longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            enterActionMode({ port: p.port, url, repo });
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
          if (isAgent && p.agentSession) {
            window.dispatchEvent(new CustomEvent('o8:open-agent-terminal', { detail: { session: p.agentSession } }));
            return;
          }
          if (onPortPreview) onPortPreview(p.port, url, repo || undefined);
          else openExternalUrl(url);
        }}
        style={PORT_ROW_STYLE}
        title={isAgent
          ? 'Click to watch the live terminal · Long-press for actions'
          : 'Click to preview · Long-press or right-click for actions'}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        <Glyph width={13} height={13} color={accent} strokeWidth={2} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1 }}>{isAgent ? `Agent · ${portLabel(p.port)}` : portLabel(p.port)}</span>
        <span style={PORT_NUM_STYLE}>:{p.port}</span>
      </button>
    );
  };

  const renderRunButton = (run: ManagedRun) => {
    const label = run.command.length > 30 ? `${run.command.slice(0, 29)}…` : run.command;
    return (
      <button
        key={`run-${run.session}`}
        type="button"
        onClick={() => {
          setOpen(false);
          window.dispatchEvent(new CustomEvent('o8:open-agent-terminal', { detail: { session: run.session } }));
        }}
        style={PORT_ROW_STYLE}
        title={`Watch the live terminal: ${run.command}`}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        <TerminalIcon width={13} height={13} color="var(--t-accent)" strokeWidth={2} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={PORT_NUM_STYLE}>run</span>
      </button>
    );
  };

  return (
    <div
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
          background: agentCount > 0 ? 'var(--t-accent-soft)' : 'var(--t-success-soft)',
          color: agentCount > 0 ? 'var(--t-accent)' : 'var(--t-success)',
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
        {compactTotal}
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
            minWidth: 200,
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
              paddingLeft: 8,
              fontSize: 10,
              fontWeight: 300,
              color: 'var(--t-text-faint)',
              letterSpacing: '-0.1px',
            }}
          >
            {displayTotal} active port{displayTotal === 1 ? '' : 's'}
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
              {agentCount > 0 ? (
                <>
                  {showLabels ? <SectionLabel>Agent</SectionLabel> : null}
                  {agentPorts.map(renderPortButton)}
                  {portlessRuns.map(renderRunButton)}
                </>
              ) : null}
              {browserPorts.length > 0 ? (
                <>
                  {showLabels ? <SectionLabel>Browser</SectionLabel> : null}
                  {browserPorts.map(renderPortButton)}
                </>
              ) : null}
              {noisePorts.length > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={() => setNoiseExpanded((v) => !v)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      paddingTop: 5,
                      paddingRight: 8,
                      paddingBottom: 4,
                      paddingLeft: 8,
                      borderWidth: 0,
                      borderRadius: 6,
                      background: 'transparent',
                      color: 'var(--t-text-faint)',
                      fontSize: 9,
                      fontWeight: 600,
                      letterSpacing: '0.5px',
                      textTransform: 'uppercase',
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
                        transform: noiseExpanded ? 'rotate(90deg)' : 'none',
                        transition: 'transform 120ms ease',
                      }}
                    >
                      <ChevronRight size={10} strokeWidth={2} />
                    </span>
                    <span style={{ flex: 1 }}>Background · {noisePorts.length}</span>
                  </button>
                  {noiseExpanded ? noisePorts.map(renderPortButton) : null}
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
    letterSpacing: 0,
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
    fontFamily: 'var(--font-sans-system)',
  };

  const toastTone = toast?.tone === 'success' ? 'var(--t-success)' : 'var(--t-danger)';

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
            letterSpacing: 0,
          }}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}
