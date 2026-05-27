'use client';

/**
 * UpdateCard — inline card for the AgentPanel bottom slot.
 *
 * Replaces the old center-top UpdateBanner. The banner covered the
 * workspace tab strip and reconnect status row whenever an update was
 * available; relocating it to the left rail (just above the chrome
 * icons) lets the operator dismiss + read changelog without losing
 * content area.
 *
 * Collapsed: orange dot · "Update available" · v0.1.X · Restart pill · dismiss
 * Expanded:  + release notes block (capped scroll). Tauri updater already
 * surfaces the GitHub release body, so no extra Brain round-trip is needed
 * for the common case.
 */

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { openExternalUrl } from '@/lib/desktop/open-external';

interface UpdateInfo {
  version: string;
  currentVersion?: string;
  notes?: string;
  date?: string;
  releaseUrl?: string;
}

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;
const SESSION_DISMISS_KEY = 'o8:update-banner:dismissed';
const EXPANDED_KEY = 'o8:update-card:expanded';
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

function readExpanded() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === '1';
  } catch {
    return false;
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

export function UpdateCard() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissedVersion());
  const [expanded, setExpanded] = useState<boolean>(() => readExpanded());

  const handleDismiss = useCallback(() => {
    const version = update?.version ?? '';
    setDismissed(version);
    try {
      window.localStorage.setItem(SESSION_DISMISS_KEY, version);
    } catch { /* ignore */ }
  }, [update?.version]);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(EXPANDED_KEY, next ? '1' : '0');
      } catch { /* ignore */ }
      return next;
    });
  }, []);

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
      // Update checks are best-effort; next interval retries.
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let availableUnlisten: Promise<() => void> | null = null;
    let clearUnlisten: Promise<() => void> | null = null;
    void import('@tauri-apps/api/event').then(({ listen }) => {
      if (cancelled) return;
      availableUnlisten = listen<UpdateInfo>(UPDATE_AVAILABLE_EVENT, (event) => {
        const next = normalizeUpdateInfo(event.payload);
        if (next) setUpdate(next);
      });
      clearUnlisten = listen<void>(UPDATE_CLEAR_EVENT, () => {
        setUpdate(null);
        setInstalling(false);
      });
    }).catch(() => { /* polling fallback below */ });
    return () => {
      cancelled = true;
      void availableUnlisten?.then((u) => u()).catch(() => {});
      void clearUnlisten?.then((u) => u()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    void checkForUpdate();
    const interval = window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL);
    return () => window.clearInterval(interval);
  }, [checkForUpdate]);

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
      console.error('[update-card] install failed:', err);
      setInstalling(false);
    }
  }, [update?.releaseUrl]);

  if (!update) return null;
  if (dismissed && dismissed === update.version) return null;

  const cardStyle: CSSProperties = {
    flexShrink: 0,
    marginLeft: 8,
    marginRight: 8,
    marginBottom: 6,
    paddingTop: 8,
    paddingRight: 10,
    paddingBottom: 8,
    paddingLeft: 10,
    borderRadius: 10,
    border: '1px solid var(--t-divider-subtle)',
    background: 'var(--t-bg-card, var(--t-panel-solid))',
    boxShadow: '0 4px 14px rgba(15, 23, 42, 0.08)',
    fontFamily: 'var(--font-sans-system)',
    color: 'var(--t-text)',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 24,
    cursor: 'pointer',
  };

  const restartStyle: CSSProperties = {
    flexShrink: 0,
    height: 22,
    paddingLeft: 9,
    paddingRight: 9,
    borderRadius: 6,
    border: '1px solid var(--t-brand-orange, #FF5A1F)',
    background: installing ? 'transparent' : 'rgba(255, 90, 31, 0.08)',
    color: 'var(--t-brand-orange, #FF5A1F)',
    fontSize: 11,
    fontWeight: 400,
    letterSpacing: '-0.1px',
    fontFamily: 'inherit',
    cursor: installing ? 'wait' : 'pointer',
    opacity: installing ? 0.7 : 1,
  };

  const dismissStyle: CSSProperties = {
    flexShrink: 0,
    height: 22,
    width: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: 'var(--t-text-faint)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 14,
    lineHeight: 1,
  };

  return (
    <div role="status" aria-live="polite" style={cardStyle}>
      <div
        style={headerStyle}
        onClick={toggleExpanded}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpanded();
          }
        }}
        aria-expanded={expanded}
        aria-label="Toggle update changelog"
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: 'var(--t-brand-orange, #FF5A1F)',
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
            Update available
          </span>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 360,
              color: 'var(--t-text-muted)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            v{update.version}
          </span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleInstall();
          }}
          disabled={installing}
          style={restartStyle}
        >
          {installing ? 'Installing…' : 'Restart'}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleDismiss();
          }}
          aria-label="Dismiss update for this session"
          style={dismissStyle}
        >
          ×
        </button>
      </div>

      {expanded ? (
        <div
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid var(--t-divider-subtle)',
            maxHeight: 220,
            overflowY: 'auto',
            fontSize: 11,
            fontWeight: 320,
            lineHeight: 1.5,
            color: 'var(--t-text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {update.notes?.trim() ? update.notes : 'No release notes published for this version.'}
        </div>
      ) : null}
    </div>
  );
}
