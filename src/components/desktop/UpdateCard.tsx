'use client';

/** App update controller, with a legacy card outside the compact rail. */

import { publishAppUpdateView, refreshCliUpdateView, registerAppUpdateCheck } from '@/lib/app-update/update-hub-client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { UpdateAutoApply } from '@/lib/app-update/types';
import { readCachedSummary, writeCachedSummary } from '@/lib/app-update/changelog-cache';
import { fetchOperatorDefaultsValues } from '@/lib/operator/operator-defaults-values-client';
import { isTauri, canUseTauriEvents } from '@/lib/tauri/bridge';
import {
  BundleIntegrityWarning,
  type BundleIntegrityStatus,
} from '@/components/desktop/BundleIntegrityWarning';
import {
  installUpdateAndRestart,
  relaunchInstalledUpdate,
  RELEASE_URL,
  type UpdateProgress,
} from '@/lib/app-update/client-restart';
import type { AppUpdateBlockers } from '@/lib/app-update/update-hub-client';
import {
  describeInstallError, describeUpdateBlockers, normalizeUpdateInfo, stringFromRecord,
  updateCheckReport, normalizeUpdateCheckReport,
  type UpdateInfo, type UpdateCheckReport, type UpdateIdleResponse,
} from '@/lib/app-update/update-card-view';
export { describeInstallError, describeUpdateBlockers } from '@/lib/app-update/update-card-view';
import {
  normalizeInstallInfo,
  resolveUpdateAction,
  type InstallInfo,
} from '@/lib/app-update/install-target';

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;

/** Tells the server about an install attempt, so a remote apply can read its outcome (#3588). */
function reportInstall(install: { outcome: 'started' | 'failed'; version: string | null; error?: string }) {
  fetch('/api/panel/app/update-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ install }),
  }).catch(() => { /* best-effort, like the check state */ });
}
const SESSION_DISMISS_KEY = 'o8:update-banner:dismissed';
const EXPANDED_KEY = 'o8:update-card:expanded';
const APPLY_MUTATIONS_KEY = 'o8:update-card:apply-mutations';
const UPDATE_AVAILABLE_EVENT = 'o8://update-available';
const UPDATE_CLEAR_EVENT = 'o8://update-clear';
const BUNDLE_SIGNATURE_INVALID_EVENT = 'o8://bundle-signature-invalid';
const AUTO_APPLY_CHECK_MS = 60 * 1000;
let updateInstallInFlight = false;

interface InstallRequest {
  requireIdle?: boolean;
  /** True only for the operator pressing the card's action button. */
  userInitiated?: boolean;
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

export function UpdateCard({ quiet = false }: { quiet?: boolean }) {
  return <AppUpdateCard quiet={quiet} />;
}

function AppUpdateCard({ quiet }: { quiet: boolean }) {
  const changelogId = useId();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checkReport, setCheckReport] = useState<UpdateCheckReport>(() => updateCheckReport('never'));
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissedVersion());
  const [expanded, setExpanded] = useState<boolean>(() => readExpanded());
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [updateAutoApply, setUpdateAutoApply] = useState<UpdateAutoApply>('off');
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [bundleIntegrity, setBundleIntegrity] = useState<BundleIntegrityStatus | null>(null);
  const [installInfo, setInstallInfo] = useState<InstallInfo | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [blockers, setBlockers] = useState<AppUpdateBlockers | null>(null);
  const updateRef = useRef<UpdateInfo | null>(null);
  const installInfoRef = useRef<InstallInfo | null>(null);
  const installingRef = useRef(false);
  const autoApplyingRef = useRef(false);
  const restartDeferredRef = useRef(false);

  useEffect(() => {
    publishAppUpdateView({ version: update?.version ?? null, currentVersion: update?.currentVersion ?? null, outcome: checkReport.outcome, installing,
      message: blockedNote, error: installError || checkReport.error, downloadOnly: resolveUpdateAction(installInfo, update?.version ?? null).kind === 'download',
      progress, blockers });
  }, [update, checkReport, installing, blockedNote, installError, installInfo, progress, blockers]);
  useEffect(() => { void refreshCliUpdateView(); }, []);

  useEffect(() => {
    updateRef.current = update;
  }, [update]);

  useEffect(() => {
    installingRef.current = installing;
  }, [installing]);

  useEffect(() => {
    installInfoRef.current = installInfo;
  }, [installInfo]);

  // What the running install is capable of. Only the server can read
  // process.platform + APPIMAGE; a deb/rpm Linux install can never
  // restart-to-install, so the card offers the release download instead.
  useEffect(() => {
    fetch('/api/panel/app/install-info', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const next = normalizeInstallInfo(await response.json());
        if (next) setInstallInfo(next);
      })
      .catch(() => { /* unknown install stays on the existing restart path */ });
  }, []);

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
      setCheckReport(updateCheckReport('available'));
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
    if (!canUseTauriEvents()) return { version: null, error: 'o8 update checking is available in the desktop app.' };
    try {
      const { check } = await import('@/lib/app-update/check');
      const result = await check();
      if (result) {
        setUpdate({
          version: result.version,
          currentVersion: result.currentVersion || undefined,
          notes: result.body ?? undefined,
          date: result.date ?? undefined,
        });
        setCheckReport(updateCheckReport('available'));
        return { version: result.version };
      } else {
        setUpdate(null);
        setCheckReport(updateCheckReport('current'));
        return { version: null };
      }
    } catch (error) {
      setCheckReport(updateCheckReport('failed', error));
      return { version: null, error: error instanceof Error ? error.message : 'o8 update check failed.' };
    }
  }, []);

  useEffect(() => {
    fetchOperatorDefaultsValues()
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
    if (!isTauri() || !canUseTauriEvents()) return;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<BundleIntegrityStatus>('get_running_bundle_integrity'))
      .then((status) => setBundleIntegrity(status))
      .catch((error) => {
        console.warn('[update-card] bundle integrity status unavailable:', error);
      });
  }, []);

  useEffect(() => {
    // Main-window only — these update listeners in the native browser-view
    // would ACL-crash (see canUseTauriEvents).
    if (!canUseTauriEvents()) return;
    let cancelled = false;
    let availableUnlisten: Promise<() => void> | null = null;
    let clearUnlisten: Promise<() => void> | null = null;
    let integrityUnlisten: Promise<() => void> | null = null;
    void import('@tauri-apps/api/event').then(({ listen }) => {
      if (cancelled) return;
      availableUnlisten = listen<UpdateInfo>(UPDATE_AVAILABLE_EVENT, (event) => {
        const next = normalizeUpdateInfo(event.payload);
        if (next) {
          const payload = event.payload as unknown as Record<string, unknown>;
          setUpdate(next);
          setCheckReport(updateCheckReport(
            'available',
            null,
            stringFromRecord(payload, ['checkedAt', 'checked_at']) ?? new Date().toISOString(),
          ));
        }
      });
      clearUnlisten = listen<unknown>(UPDATE_CLEAR_EVENT, (event) => {
        const nextReport = normalizeUpdateCheckReport(event.payload) ?? updateCheckReport('current');
        setCheckReport(nextReport);
        if (nextReport.outcome === 'current') {
          setUpdate(null);
          setBlockers(null);
          setInstalling(false);
          restartDeferredRef.current = false;
        }
      });
      integrityUnlisten = listen<BundleIntegrityStatus>(BUNDLE_SIGNATURE_INVALID_EVENT, (event) => {
        setBundleIntegrity(event.payload);
      });
    }).catch(() => { /* polling fallback below */ });
    return () => {
      cancelled = true;
      void availableUnlisten?.then((u) => u()).catch(() => {});
      void clearUnlisten?.then((u) => u()).catch(() => {});
      void integrityUnlisten?.then((u) => u()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    void checkForUpdate();
    const interval = window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL);
    return () => window.clearInterval(interval);
  }, [checkForUpdate]);

  useEffect(() => {
    if (checkReport.outcome === 'never') return;
    fetch('/api/panel/app/update-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updatePending: Boolean(update),
        version: update?.version ?? null,
        checkOutcome: checkReport.outcome,
        checkedAt: checkReport.checkedAt,
        checkError: checkReport.error,
      }),
    }).catch(() => { /* route is best-effort state for CLI --if-update-pending */ });
  }, [checkReport, update]);

  useEffect(() => registerAppUpdateCheck(checkForUpdate), [checkForUpdate]);

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

  const readUpdateIdle = useCallback(async () => {
    const response = await fetch('/api/panel/update/apply', { cache: 'no-store' }).catch(() => null);
    if (!response?.ok) return null;
    return await response.json().catch(() => null) as UpdateIdleResponse | null;
  }, []);

  const checkUpdateIdle = useCallback(async (allowParked = false) => {
    const payload = await readUpdateIdle();
    if (payload?.idle?.idle === true) return true;
    return allowParked && payload?.idle?.idleExceptParked === true;
  }, [readUpdateIdle]);

  /** Names the blockers and returns a note that matches them. */
  const explainWaitingRestart = useCallback(async () => {
    const payload = await readUpdateIdle();
    const named = describeUpdateBlockers(payload);
    setBlockers(named);
    if (payload?.idle?.active?.restartPending) return 'Update installed. Another restart is already in progress.';
    const installers = payload?.idle?.active?.cliInstallers ?? [];
    if (installers.some(installer => installer.state !== 'active') || payload?.idle?.unavailable?.includes('cli-update-ownership')) {
      return 'Update installed. Restart needs CLI update recovery; check the tool and its update receipt.';
    }
    if (installers.length) return 'Update installed. Restart is waiting for CLI updates to finish.';
    return named.live.length
      ? 'Update installed. Restart is waiting for running work to finish.'
      : named.parked.length
        ? 'Update installed. Restart now to apply it. Waiting tasks keep their state.'
        : 'Update installed. Restart is waiting for lanes and terminals to become idle.';
  }, [readUpdateIdle]);

  const handleInstall = useCallback(async (request: InstallRequest = {}) => {
    if (installingRef.current || updateInstallInFlight) return;
    const action = resolveUpdateAction(installInfoRef.current, updateRef.current?.version ?? null);
    if (action.kind === 'download' && !request.userInitiated) {
      // Background applies (idle auto-apply, remote apply mutation) never open
      // a browser on the operator's behalf.
      setBlockedNote('This install updates by download. o8 cannot replace a deb or rpm install in place.');
      return;
    }
    updateInstallInFlight = true;
    installingRef.current = true;
    try {
      setInstalling(true);
      setBlockedNote(null);
      setInstallError(null);
      setBlockers(null);
      // Background applies stay idle-first. An operator's click downloads and
      // installs first, so the update is staged even if the restart must wait.
      if (action.kind === 'restart' && request.requireIdle && !request.userInitiated && !(await checkUpdateIdle())) {
        setBlockedNote('Update ready. Restart is waiting for lanes and terminals to become idle.');
        return;
      }
      if (action.kind === 'restart' && restartDeferredRef.current) {
        const restarted = await relaunchInstalledUpdate({
          beforeRestart: request.requireIdle ? () => checkUpdateIdle() : undefined,
        });
        if (!restarted) setBlockedNote(await explainWaitingRestart());
        return;
      }
      reportInstall({ outcome: 'started', version: updateRef.current?.version ?? null });
      const outcome = await installUpdateAndRestart(
        action.kind === 'download' ? action.url : updateRef.current?.releaseUrl ?? RELEASE_URL,
        {
          beforeRestart: request.requireIdle ? () => checkUpdateIdle() : undefined,
          selfUpdatable: action.kind === 'restart',
          onProgress: setProgress,
        },
      );
      if (outcome.downloadOpened) return;
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
        setBlockedNote(await explainWaitingRestart());
      }
    } catch (err) {
      const message = describeInstallError(err);
      console.error(`[update-card] install failed: ${message || '(no message)'}`, err);
      setInstallError(`Update failed before restart.${message ? ` ${message}` : ''}`);
      reportInstall({ outcome: 'failed', version: updateRef.current?.version ?? null, error: message });
    } finally {
      updateInstallInFlight = false;
      installingRef.current = false;
      setInstalling(false);
      setProgress(null);
    }
  }, [checkUpdateIdle, explainWaitingRestart]);
  useEffect(() => {
    const install = () => { void handleInstall({ userInitiated: true, requireIdle: true }); };
    window.addEventListener('o8:install-app-update', install);
    return () => window.removeEventListener('o8:install-app-update', install);
  }, [handleInstall]);

  // "Restart now" from the panel, after the operator has read the named waiting
  // tasks. It restarts past parked tasks only; running work still blocks it.
  useEffect(() => {
    const restartNow = async () => {
      if (!restartDeferredRef.current || installingRef.current || updateInstallInFlight) return;
      updateInstallInFlight = true;
      installingRef.current = true;
      setInstalling(true);
      setInstallError(null);
      try {
        setProgress({ stage: 'restarting', receivedBytes: 0, totalBytes: null });
        const restarted = await relaunchInstalledUpdate({ beforeRestart: () => checkUpdateIdle(true) });
        if (!restarted) setBlockedNote(await explainWaitingRestart());
      } catch (err) {
        setInstallError(`Restart failed.${describeInstallError(err) ? ` ${describeInstallError(err)}` : ''}`);
      } finally {
        updateInstallInFlight = false;
        installingRef.current = false;
        setInstalling(false);
        setProgress(null);
      }
    };
    const onRestart = () => { void restartNow(); };
    window.addEventListener('o8:restart-app-update', onRestart);
    return () => window.removeEventListener('o8:restart-app-update', onRestart);
  }, [checkUpdateIdle, explainWaitingRestart]);

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

  if (bundleIntegrity?.status === 'invalid') {
    return <BundleIntegrityWarning status={bundleIntegrity} />;
  }
  // The navigation rail renders the quiet card; a failed install still shows there (#3588).
  if (quiet) {
    return installError ? (
      <div role="alert" style={{ marginTop: 6, marginLeft: 8, marginRight: 8, padding: 8, borderRadius: 8,
        border: '1px solid var(--t-danger-border)', fontSize: 10.5, fontWeight: 320, lineHeight: 1.5,
        color: 'var(--t-danger)', wordBreak: 'break-word' }}>
        {installError}
      </div>
    ) : null;
  }
  if (!update) return null;
  if (dismissed && dismissed === update.version) return null;

  // A deb/rpm Linux install cannot replace itself, so the same slot carries a
  // download link to the release asset instead of restart-to-install.
  const action = resolveUpdateAction(installInfo, update.version);
  const actionLabel = action.kind === 'download' ? 'Download' : 'Restart';

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
        aria-controls={expanded ? changelogId : undefined}
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
            void handleInstall({ userInitiated: true });
          }}
          disabled={installing}
          aria-label={action.kind === 'download'
            ? `Download o8 v${update.version}`
            : `Restart to install o8 v${update.version}`}
          style={restartStyle}
        >
          {installing && action.kind === 'restart' ? 'Installing…' : actionLabel}
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

      {installError ? (
        <div
          role="alert"
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid var(--t-danger-border)',
            fontSize: 10.5,
            fontWeight: 320,
            lineHeight: 1.5,
            color: 'var(--t-danger)',
            wordBreak: 'break-word',
          }}
        >
          {installError}
        </div>
      ) : null}

      {expanded ? (
        <div
          id={changelogId}
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
