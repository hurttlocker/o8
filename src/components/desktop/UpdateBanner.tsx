'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';

interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
const SESSION_DISMISS_KEY = 'o8:update-banner:dismissed';

/**
 * UpdateBanner — compact 22px footer pill that surfaces inside the
 * DesktopStatusBar, sized to match the other chrome chips (FooterPorts,
 * SupervisorInboxBadge). Renders nothing when no update is available or
 * the operator has dismissed the current version for this session.
 *
 * Click the pill to open a small popover with the version + Restart button.
 * The dismiss-X lives inside the popover so it doesn't crowd the chrome row.
 *
 * Tauri uses the native updater. Browser/dev mode skips remote polling
 * entirely so the pill never appears with bogus data.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return window.sessionStorage.getItem(SESSION_DISMISS_KEY); } catch { return null; }
  });
  const [open, setOpen] = useState(false);
  const [popoverRight, setPopoverRight] = useState(16);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const handleDismiss = useCallback(() => {
    const version = update?.version ?? '';
    setDismissed(version);
    setOpen(false);
    try { window.sessionStorage.setItem(SESSION_DISMISS_KEY, version); } catch { /* ignore */ }
  }, [update?.version]);

  const checkForUpdate = useCallback(async () => {
    try {
      if (typeof window !== 'undefined' && 'isTauri' in window && (window as { isTauri?: boolean }).isTauri) {
        const { check } = await import('@tauri-apps/plugin-updater');
        const result = await check();
        if (result?.available) {
          setUpdate({
            version: result.version,
            notes: result.body ?? undefined,
            date: result.date ?? undefined,
          });
        }
        return;
      }
      return;
    } catch {
      // Silently fail — update checks are non-critical
    }
  }, []);

  useEffect(() => {
    void checkForUpdate();
    const interval = window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL);
    return () => window.clearInterval(interval);
  }, [checkForUpdate]);

  const handleInstall = useCallback(async () => {
    if (typeof window !== 'undefined' && 'isTauri' in window && (window as { isTauri?: boolean }).isTauri) {
      try {
        setInstalling(true);
        const { check } = await import('@tauri-apps/plugin-updater');
        const result = await check();
        if (result?.available) {
          await result.downloadAndInstall();
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        }
      } catch (err) {
        console.error('[update-banner] install failed:', err);
        setInstalling(false);
      }
    } else {
      window.open('https://github.com/hurttlocker/cortex-ide/releases/latest', '_blank');
    }
  }, []);

  if (!update) return null;
  if (dismissed && dismissed === update.version) return null;

  const togglePopover = () => {
    if (anchorRef.current && !open) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPopoverRight(Math.max(8, window.innerWidth - rect.right));
    }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={togglePopover}
        aria-label={`Update available: o8 ${update.version}`}
        title={`Update available · o8 ${update.version}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 22,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: 6,
          border: '1px solid rgba(255, 90, 31, 0.25)',
          background: 'rgba(255, 90, 31, 0.10)',
          color: '#c2410c',
          cursor: 'pointer',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: '#FF5A1F',
            boxShadow: '0 0 0 2px rgba(255, 90, 31, 0.18)',
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '-0.01em' }}>
          Update
        </span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: 'var(--t-text-faint)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}
        >
          {update.version}
        </span>
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          style={{
            position: 'fixed',
            bottom: 36,
            right: popoverRight,
            minWidth: 260,
            paddingTop: 10,
            paddingRight: 12,
            paddingBottom: 10,
            paddingLeft: 12,
            borderRadius: 12,
            background: 'var(--t-panel-solid)',
            border: '1px solid var(--t-panel-border)',
            boxShadow: 'var(--t-panel-shadow), 0 8px 24px rgba(15, 23, 42, 0.18)',
            zIndex: 9999,
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: '#FF5A1F',
                boxShadow: '0 0 0 3px rgba(255, 90, 31, 0.18)',
              }}
            />
            <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>
              Update available
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--t-text-muted)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}
            >
              {update.version}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={handleInstall}
              disabled={installing}
              style={{
                flex: 1,
                paddingTop: 6,
                paddingRight: 12,
                paddingBottom: 6,
                paddingLeft: 12,
                borderRadius: 8,
                border: '1px solid var(--t-text)',
                background: 'var(--t-text)',
                color: 'var(--t-chat-surface-bg)',
                fontFamily: 'inherit',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                cursor: installing ? 'wait' : 'pointer',
                opacity: installing ? 0.6 : 1,
              }}
            >
              {installing ? 'Installing…' : 'Restart to update'}
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              aria-label="Dismiss for this session"
              title="Dismiss for this session"
              style={{
                paddingTop: 6,
                paddingRight: 10,
                paddingBottom: 6,
                paddingLeft: 10,
                borderRadius: 8,
                border: '1px solid var(--t-divider)',
                background: 'transparent',
                color: 'var(--t-text-muted)',
                fontFamily: 'inherit',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Later
            </button>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
