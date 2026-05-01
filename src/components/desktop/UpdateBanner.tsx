'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
const POP_CURVE = 'cubic-bezier(0.34, 1.36, 0.64, 1)';
const SESSION_ANIM_KEY = 'o8:update-banner:animated';
const SESSION_DISMISS_KEY = 'o8:update-banner:dismissed';

/**
 * UpdateBanner — center-top sticky notification when a new version is
 * available. On Tauri desktop, uses the native updater. We intentionally
 * skip browser-only update fetches in local/web mode to avoid noisy CORS
 * console failures against GitHub release assets.
 *
 * Placement: position-fixed, centered horizontally just below the 44px
 * TitleBar. Solid paper surface (NOT glass — this is a notification, not
 * chrome) with the brand orange LED indicator. Slides in with the canonical
 * pop curve once per session via sessionStorage.
 *
 * Surface timing: the Tauri updater check fires on first mount with no
 * artificial delay, so the banner can appear within the first second of
 * webview boot rather than after the dashboard fully hydrates.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Per-session dismissal — operator can hide the banner if they're not
  // ready to restart. Reappears on the next launch (intentional: we want
  // them to know there's an update at some point).
  const [dismissed, setDismissed] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return window.sessionStorage.getItem(SESSION_DISMISS_KEY); } catch { return null; }
  });
  const handleDismiss = useCallback(() => {
    const version = update?.version ?? '';
    setDismissed(version);
    try { window.sessionStorage.setItem(SESSION_DISMISS_KEY, version); } catch { /* ignore */ }
  }, [update?.version]);
  const animatedRef = useRef(false);

  const checkForUpdate = useCallback(async () => {
    try {
      // Try Tauri native updater first
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

      // Browser/dev mode: skip remote release polling.
      // The desktop product path should use the Tauri updater instead.
      return;
    } catch {
      // Silently fail — update checks are non-critical
    }
  }, []);

  useEffect(() => {
    // Read whether this session has already played the slide-in.
    if (typeof window !== 'undefined') {
      try {
        animatedRef.current = window.sessionStorage.getItem(SESSION_ANIM_KEY) === '1';
      } catch {
        // sessionStorage can throw in private browsing — treat as fresh.
      }
    }

    // Fire immediately so the banner can surface as soon as the Tauri
    // updater resolves, not after the full dashboard hydration chain.
    void checkForUpdate();
    const interval = window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL);
    return () => {
      window.clearInterval(interval);
    };
  }, [checkForUpdate]);

  // Trigger the entrance transition on the next frame after the update
  // payload arrives. Use rAF so the initial render commits the
  // off-screen styles before we flip to the on-screen ones.
  useEffect(() => {
    if (!update) {
      setMounted(false);
      return;
    }
    let rafId: number | null = null;
    rafId = window.requestAnimationFrame(() => {
      setMounted(true);
      try {
        window.sessionStorage.setItem(SESSION_ANIM_KEY, '1');
      } catch {
        // ignore
      }
    });
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [update]);

  const handleInstall = useCallback(async () => {
    if (typeof window !== 'undefined' && 'isTauri' in window && (window as { isTauri?: boolean }).isTauri) {
      try {
        setInstalling(true);
        const { check } = await import('@tauri-apps/plugin-updater');
        const result = await check();
        if (result?.available) {
          await result.downloadAndInstall();
          // Relaunch after install
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        }
      } catch (err) {
        console.error('[update-banner] install failed:', err);
        setInstalling(false);
      }
    } else {
      // Web fallback — open releases page
      window.open('https://github.com/hurttlocker/cortex-ide/releases/latest', '_blank');
    }
  }, []);

  if (!update) return null;
  if (dismissed && dismissed === update.version) return null;

  // If we already animated this session (e.g. component re-mounted after
  // a tab change), skip the slide-in by starting in the mounted state.
  const skipAnimation = animatedRef.current;
  const isOnScreen = mounted || skipAnimation;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        // Top-right corner toast — out of the way of the workspace tab
        // strip + command palette. Sits below the 44px TitleBar.
        position: 'fixed',
        top: 52,
        right: 16,
        transform: isOnScreen
          ? 'translate(0, 0)'
          : 'translate(0, -16px)',
        opacity: isOnScreen ? 1 : 0,
        transition: skipAnimation
          ? 'none'
          : `transform 220ms ${POP_CURVE}, opacity 220ms ${POP_CURVE}`,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 16,
        background: 'var(--t-chat-surface-bg)',
        border: '1px solid var(--t-border)',
        borderRadius: 12,
        boxShadow: '0 12px 32px rgba(15, 23, 42, 0.16), 0 2px 6px rgba(15, 23, 42, 0.08)',
        fontSize: 13,
        color: 'var(--t-text)',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        zIndex: 9100,
        pointerEvents: 'auto',
        maxWidth: 'min(560px, calc(100vw - 32px))',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#FF5A1F',
          boxShadow: '0 0 0 3px rgba(255, 90, 31, 0.18)',
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1, minWidth: 0, lineHeight: 1.3 }}>
        <strong style={{ fontWeight: 600, color: 'var(--t-text)' }}>
          Update available
        </strong>
        <span style={{ marginLeft: 8, color: 'var(--t-text-muted)', fontWeight: 400 }}>
          o8 {update.version}
        </span>
      </span>
      <button
        type="button"
        onClick={handleInstall}
        disabled={installing}
        style={{
          paddingTop: 6,
          paddingRight: 14,
          paddingBottom: 6,
          paddingLeft: 14,
          borderRadius: 10,
          border: '1px solid var(--t-text)',
          background: 'var(--t-text)',
          color: 'var(--t-chat-surface-bg)',
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          cursor: installing ? 'wait' : 'pointer',
          opacity: installing ? 0.6 : 1,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {installing ? 'Installing…' : 'Restart to update'}
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss update banner"
        title="Dismiss for this session"
        style={{
          width: 28,
          height: 28,
          marginLeft: 4,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: 8,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          flexShrink: 0,
          fontFamily: 'inherit',
          fontSize: 14,
          lineHeight: 1,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-muted)'; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>
    </div>
  );
}
