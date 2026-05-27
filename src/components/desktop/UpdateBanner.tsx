'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '@/lib/tauri/bridge';
import { openExternalUrl } from '@/lib/desktop/open-external';

interface UpdateInfo {
  version: string;
  currentVersion?: string;
  notes?: string;
  date?: string;
  releaseUrl?: string;
}

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
const SESSION_DISMISS_KEY = 'o8:update-banner:dismissed';
const UPDATE_AVAILABLE_EVENT = 'o8://update-available';
const UPDATE_CLEAR_EVENT = 'o8://update-clear';
const RELEASE_URL = 'https://github.com/hurttlocker/o8/releases/latest';

function readDismissedVersion() {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(SESSION_DISMISS_KEY);
  } catch {
    return null;
  }
}

function stringFromRecord(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function normalizeUpdateInfo(payload: unknown): UpdateInfo | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const version = stringFromRecord(record, ['version']);
  if (!version) return null;

  return {
    version,
    currentVersion: stringFromRecord(record, ['currentVersion', 'current_version']),
    notes: stringFromRecord(record, ['notes', 'body']),
    date: stringFromRecord(record, ['date']),
    releaseUrl: stringFromRecord(record, ['releaseUrl', 'release_url', 'url']),
  };
}

/**
 * Center-top updater banner. Rust can push the first update result over
 * Tauri's event bus, and the regular 30-minute JS poll stays as a fallback.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissedVersion());
  const [entered, setEntered] = useState(false);
  const updateVersion = update?.version;

  const handleDismiss = useCallback(() => {
    const version = update?.version ?? '';
    setDismissed(version);
    try {
      window.localStorage.setItem(SESSION_DISMISS_KEY, version);
    } catch {
      /* ignore */
    }
  }, [update?.version]);

  const checkForUpdate = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const result = await check();
      if (result) {
        setUpdate({
          version: result.version,
          notes: result.body ?? undefined,
          date: result.date ?? undefined,
        });
      } else {
        setUpdate(null);
      }
    } catch {
      // Update checks are non-critical; the next interval can retry.
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;
    let availableUnlisten: Promise<() => void> | null = null;
    let clearUnlisten: Promise<() => void> | null = null;

    void import('@tauri-apps/api/event')
      .then(({ listen }) => {
        if (cancelled) return;
        availableUnlisten = listen<UpdateInfo>(UPDATE_AVAILABLE_EVENT, (event) => {
          const next = normalizeUpdateInfo(event.payload);
          if (next) setUpdate(next);
        });
        clearUnlisten = listen<void>(UPDATE_CLEAR_EVENT, () => {
          setUpdate(null);
          setInstalling(false);
        });
      })
      .catch(() => {
        /* polling below remains the fallback */
      });

    return () => {
      cancelled = true;
      void availableUnlisten?.then((unlisten) => unlisten()).catch(() => {});
      void clearUnlisten?.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    void checkForUpdate();
    const interval = window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL);
    return () => window.clearInterval(interval);
  }, [checkForUpdate]);

  useEffect(() => {
    if (!updateVersion || dismissed === updateVersion) return;
    setEntered(false);
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [dismissed, updateVersion]);

  const handleInstall = useCallback(async () => {
    if (!isTauri()) {
      openExternalUrl(update?.releaseUrl ?? RELEASE_URL);
      return;
    }

    try {
      setInstalling(true);
      const { check } = await import('@tauri-apps/plugin-updater');
      const result = await check();
      if (result) {
        await result.downloadAndInstall();
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      }
      setInstalling(false);
    } catch (err) {
      console.error('[update-banner] install failed:', err);
      setInstalling(false);
    }
  }, [update?.releaseUrl]);

  if (!update) return null;
  if (dismissed && dismissed === update.version) return null;
  if (typeof document === 'undefined') return null;

  const containerStyle: CSSProperties = {
    position: 'fixed',
    top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
    left: '50%',
    zIndex: 10000,
    width: 'min(560px, calc(100vw - 32px))',
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    paddingTop: 8,
    paddingRight: 10,
    paddingBottom: 8,
    paddingLeft: 12,
    borderRadius: 8,
    border: '1px solid var(--t-panel-border, var(--border))',
    borderLeft: '3px solid var(--t-brand-orange, var(--t-accent))',
    background: 'var(--t-panel-solid, var(--panel-strong))',
    boxShadow: 'var(--t-panel-shadow, var(--shadow))',
    color: 'var(--t-text, var(--text))',
    fontFamily: 'var(--font-sans-system)',
    transform: entered ? 'translate(-50%, 0)' : 'translate(-50%, -12px)',
    opacity: entered ? 1 : 0,
    transition: 'transform 200ms cubic-bezier(0.34, 1.36, 0.64, 1), opacity 160ms ease-out',
    pointerEvents: 'auto',
  };

  const buttonStyle: CSSProperties = {
    flexShrink: 0,
    height: 28,
    paddingTop: 0,
    paddingRight: 12,
    paddingBottom: 0,
    paddingLeft: 12,
    borderRadius: 7,
    border: '1px solid var(--t-brand-orange, var(--t-accent))',
    background: 'var(--t-bg-card, var(--panel))',
    color: 'var(--t-text-strong, var(--text))',
    fontFamily: 'inherit',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0,
    cursor: installing ? 'wait' : 'pointer',
    opacity: installing ? 0.72 : 1,
  };

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={containerStyle}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: 'var(--t-brand-orange, var(--t-accent))',
          boxShadow: '0 0 0 3px var(--t-accent-soft, var(--t-bg-card))',
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--t-text, var(--text))' }}>
            Update available
          </span>
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--t-text-muted, var(--text-secondary))',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}
          >
            {update.version}
          </span>
        </div>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--t-text-faint, var(--muted))',
          }}
        >
          Restart o8 to install the latest build.
        </span>
      </div>
      <button
        type="button"
        onClick={handleInstall}
        disabled={installing}
        style={buttonStyle}
      >
        {installing ? 'Installing...' : 'Restart'}
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss update banner for this session"
        title="Dismiss for this session"
        style={{
          flexShrink: 0,
          height: 28,
          paddingTop: 0,
          paddingRight: 10,
          paddingBottom: 0,
          paddingLeft: 10,
          borderRadius: 7,
          border: '1px solid var(--t-divider-subtle, var(--border))',
          background: 'var(--t-input-bg, transparent)',
          color: 'var(--t-text-muted, var(--text-secondary))',
          fontFamily: 'inherit',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0,
          cursor: 'pointer',
        }}
      >
        Later
      </button>
    </div>,
    document.body,
  );
}
