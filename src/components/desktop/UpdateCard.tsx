'use client';

/**
 * UpdateCard — inline card for the AgentPanel bottom slot.
 *
 * Replaces the old center-top UpdateBanner. The banner covered the
 * workspace tab strip + reconnect row whenever an update was available;
 * relocating it to the left rail (just above the chrome icons) lets the
 * operator dismiss + read changelog without losing content area.
 *
 * Collapsed shape:
 *   [•] Update available                 [Restart] [×]
 *       v0.1.172
 *
 * Click anywhere on the body to expand. The expanded section calls
 * /api/panel/o8-update-summary (free OpenRouter pool) to render a
 * 1-paragraph professional summary from the actual GitHub release body
 * + recent commits. Result cached per version in localStorage so the
 * second open is instant.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { UpdateAutoApply } from '@/lib/app-update/types';
import { isTauri, canUseTauriEvents } from '@/lib/tauri/bridge';
import {
  installUpdateAndRestart,
  relaunchInstalledUpdate,
  RELEASE_URL,
} from '@/lib/app-update/client-restart';

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
const SUMMARY_CACHE_KEY = 'o8:update-card:summary'; // per-version map
const APPLY_MUTATIONS_KEY = 'o8:update-card:apply-mutations';
const UPDATE_AVAILABLE_EVENT = 'o8://update-available';
const UPDATE_CLEAR_EVENT = 'o8://update-clear';
const AUTO_APPLY_CHECK_MS = 60 * 1000;
let updateInstallInFlight = false;

interface InstallRequest {
  requireIdle?: boolean;
}

interface UpdateIdleResponse {
  idle?: { idle?: boolean };
}

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

function readCachedSummary(version: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SUMMARY_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    return typeof map[version] === 'string' ? map[version] : null;
  } catch {
    return null;
  }
}

function writeCachedSummary(version: string, summary: string) {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(SUMMARY_CACHE_KEY);
    const map = raw ? JSON.parse(raw) as Record<string, string> : {};
    map[version] = summary;
    window.localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

function claimApplyMutation(mutationId: string): boolean {
  try {
    const raw = window.localStorage.getItem(APPLY_MUTATIONS_KEY);
    const processed = raw ? JSON.parse(raw) as unknown : [];
    const ids = Array.isArray(processed)
      ? processed.filter((value): value is string => typeof value === 'string')
      : [];
    if (ids.includes(mutationId)) return false;
    window.localStorage.setItem(APPLY_MUTATIONS_KEY, JSON.stringify([...ids.slice(-31), mutationId]));
  } catch { /* duplicate suppression is best-effort */ }
  return true;
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
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [updateAutoApply, setUpdateAutoApply] = useState<UpdateAutoApply>('off');
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  const updateRef = useRef<UpdateInfo | null>(null);
  const installingRef = useRef(false);
  const autoApplyingRef = useRef(false);
  const restartDeferredRef = useRef(false);

  useEffect(() => {
    updateRef.current = update;
  }, [update]);

  useEffect(() => {
    installingRef.current = installing;
  }, [installing]);

  const handleDismiss = useCallback(() => {
    const version = update?.version ?? '';
    setDismissed(version);
    try {
      window.localStorage.setItem(SESSION_DISMISS_KEY, version);
    } catch { /* ignore */ }
  }, [update?.version]);

  // Manual "Check for updates" (Settings drawer) found one — show the card
  // NOW, expanded, even if this version was previously dismissed. An explicit
  // check is the operator asking to see it.
  useEffect(() => {
    const onFound = (event: Event) => {
      const next = normalizeUpdateInfo((event as CustomEvent<unknown>).detail);
      if (!next) return;
      try {
        window.localStorage.removeItem(SESSION_DISMISS_KEY);
      } catch { /* ignore */ }
      setDismissed(null);
      setUpdate(next);
      setExpanded(true);
    };
    window.addEventListener('o8:update-found', onFound);
    return () => window.removeEventListener('o8:update-found', onFound);
  }, []);

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
    fetch('/api/panel/operator-defaults', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as {
          values?: { updateAutoApply?: UpdateAutoApply };
        };
        const next = payload.values?.updateAutoApply;
        if (next === 'idle' || next === 'off') setUpdateAutoApply(next);
      })
      .catch(() => { /* default off */ });
  }, []);

  useEffect(() => {
    // Main-window only — these update listeners in the native browser-view
    // would ACL-crash (see canUseTauriEvents).
    if (!canUseTauriEvents()) return;
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
        restartDeferredRef.current = false;
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

  useEffect(() => {
    fetch('/api/panel/app/update-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatePending: Boolean(update), version: update?.version ?? null }),
    }).catch(() => { /* route is best-effort state for CLI --if-update-pending */ });
  }, [update]);

  // Fetch summary when the card is expanded and we have a version. Cache
  // by version in localStorage so repeated opens are instant.
  useEffect(() => {
    if (!expanded || !update?.version) return;
    const cached = readCachedSummary(update.version);
    if (cached) {
      setSummary(cached);
      setSummaryError(null);
      setSummaryLoading(false);
      return;
    }
    setSummary(null);
    setSummaryError(null);
    setSummaryLoading(true);
    const controller = new AbortController();
    fetch(`/api/panel/o8-update-summary?version=${encodeURIComponent(update.version)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { summary?: string; error?: string };
        if (!response.ok || !payload.summary) {
          throw new Error(payload.error || `Summary failed (${response.status}).`);
        }
        setSummary(payload.summary);
        writeCachedSummary(update.version, payload.summary);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setSummaryError(error instanceof Error ? error.message : 'Unable to load summary.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setSummaryLoading(false);
      });
    return () => controller.abort();
  }, [expanded, update?.version]);

  const checkUpdateIdle = useCallback(async () => {
    const response = await fetch('/api/panel/update/apply', { cache: 'no-store' }).catch(() => null);
    if (!response?.ok) return false;
    const payload = await response.json().catch(() => null) as UpdateIdleResponse | null;
    return payload?.idle?.idle === true;
  }, []);

  const handleInstall = useCallback(async (request: InstallRequest = {}) => {
    if (installingRef.current || updateInstallInFlight) return;
    updateInstallInFlight = true;
    installingRef.current = true;
    try {
      setInstalling(true);
      setBlockedNote(null);
      if (request.requireIdle && !(await checkUpdateIdle())) {
        setBlockedNote('Update ready. Restart is waiting for lanes and terminals to become idle.');
        return;
      }
      if (restartDeferredRef.current) {
        const restarted = await relaunchInstalledUpdate({
          beforeRestart: request.requireIdle ? checkUpdateIdle : undefined,
        });
        if (!restarted) {
          setBlockedNote('Update installed. Restart is waiting for lanes and terminals to become idle.');
        }
        return;
      }
      const outcome = await installUpdateAndRestart(
        updateRef.current?.releaseUrl ?? RELEASE_URL,
        { beforeRestart: request.requireIdle ? checkUpdateIdle : undefined },
      );
      if (outcome.blocked) {
        // Kill-switch: this version was pulled post-release. Surface a quiet
        // note instead of restarting; the operator waits for the next build.
        setBlockedNote(
          outcome.blocked.note?.trim()
            || `Update to v${outcome.blocked.version} was paused by the o8 team — waiting for a fixed build.`,
        );
      }
      if (outcome.restartDeferred) {
        restartDeferredRef.current = true;
        setBlockedNote('Update installed. Restart is waiting for lanes and terminals to become idle.');
      }
    } catch (err) {
      console.error('[update-card] install failed:', err);
    } finally {
      updateInstallInFlight = false;
      installingRef.current = false;
      setInstalling(false);
    }
  }, [checkUpdateIdle]);

  useEffect(() => {
    const onRealtime = (event: Event) => {
      const detail = (event as CustomEvent<{
        data?: {
          events?: Array<{
            data?: { mutation?: {
              action?: string;
              status?: string;
              mutationId?: string;
              force?: boolean;
            } };
          }>;
        };
      }>).detail;
      const mutations = detail?.data?.events?.map((item) => item.data?.mutation) ?? [];
      for (let index = mutations.length - 1; index >= 0; index -= 1) {
        const mutation = mutations[index];
        if (mutation?.status !== 'queued') continue;
        if (mutation.action !== 'app-relaunch-requested' && mutation.action !== 'app-update-apply-requested') continue;
        if (mutation.mutationId && !claimApplyMutation(mutation.mutationId)) continue;
        const requireIdle = mutation.action === 'app-update-apply-requested' && mutation.force !== true;
        void handleInstall({ requireIdle });
        return;
      }
    };
    window.addEventListener('o8:realtime', onRealtime);
    return () => window.removeEventListener('o8:realtime', onRealtime);
  }, [handleInstall]);

  useEffect(() => {
    if (updateAutoApply !== 'idle') return;

    async function maybeApplyWhenIdle() {
      if (!updateRef.current || installingRef.current || autoApplyingRef.current) return;
      if (!(await checkUpdateIdle())) return;

      autoApplyingRef.current = true;
      try {
        await handleInstall({ requireIdle: true });
      } finally {
        autoApplyingRef.current = false;
      }
    }

    const interval = window.setInterval(() => void maybeApplyWhenIdle(), AUTO_APPLY_CHECK_MS);
    void maybeApplyWhenIdle();
    return () => window.clearInterval(interval);
  }, [checkUpdateIdle, handleInstall, updateAutoApply]);

  if (!update) return null;
  if (dismissed && dismissed === update.version) return null;

  const cardStyle: CSSProperties = {
    flexShrink: 0,
    marginLeft: 8,
    marginRight: 8,
    marginBottom: 6,
    paddingTop: 9,
    paddingRight: 10,
    paddingBottom: 9,
    paddingLeft: 11,
    borderRadius: 10,
    border: '1px solid var(--t-divider-subtle)',
    background: 'var(--t-bg-card, var(--t-panel-solid))',
    boxShadow: '0 4px 14px var(--t-shadow-subtle, transparent)',
    fontFamily: 'var(--font-sans-system)',
    color: 'var(--t-text)',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    cursor: 'pointer',
  };

  const restartStyle: CSSProperties = {
    flexShrink: 0,
    height: 22,
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 0,
    paddingBottom: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    borderRadius: 6,
    border: '1px solid var(--t-brand-orange, #FF5A1F)',
    background: installing ? 'transparent' : 'color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 8%, transparent)',
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
        {/* Two-line label keeps the title on one row even at the 290px
            AgentPanel width. Title 11.5/300/-0.1, meta 9.5/260/-0.4 —
            the Hurttlocker row + meta-line pair. */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              color: 'var(--t-text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Update available
          </span>
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
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

      {blockedNote ? (
        <div
          role="note"
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid var(--t-divider-subtle)',
            fontSize: 10.5,
            fontWeight: 320,
            lineHeight: 1.5,
            color: 'var(--t-text-faint)',
            wordBreak: 'break-word',
          }}
        >
          {blockedNote}
        </div>
      ) : null}

      {expanded ? (
        <div
          style={{
            marginTop: 9,
            paddingTop: 9,
            borderTop: '1px solid var(--t-divider-subtle)',
            maxHeight: 200,
            overflowY: 'auto',
            fontSize: 11,
            fontWeight: 320,
            lineHeight: 1.55,
            color: 'var(--t-text-secondary)',
            wordBreak: 'break-word',
          }}
        >
          {summaryLoading ? (
            <SummarySkeleton />
          ) : summaryError ? (
            <span style={{ color: 'var(--t-text-faint)', fontSize: 10.5 }}>
              {summaryError}
            </span>
          ) : summary ? (
            summary
          ) : update.notes?.trim() ? (
            update.notes
          ) : (
            <span style={{ color: 'var(--t-text-faint)', fontSize: 10.5 }}>
              No summary available yet.
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SummarySkeleton() {
  // Three short shimmer lines — keeps the card height stable while the
  // free OpenRouter pool warms up + responds.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {[100, 92, 64].map((widthPct) => (
        <div
          key={widthPct}
          style={{
            height: 9,
            width: `${widthPct}%`,
            borderRadius: 4,
            background: 'var(--t-input-bg, var(--t-panel))',
            animation: 'o8-update-shimmer 1.6s ease-in-out infinite',
          }}
        />
      ))}
      <style>{`
        @keyframes o8-update-shimmer {
          0%, 100% { opacity: 0.45; }
          50% { opacity: 0.8; }
        }
      `}</style>
    </div>
  );
}
