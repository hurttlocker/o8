'use client';

import { isTauri } from '@/lib/tauri/bridge';
import { openExternalUrl } from '@/lib/desktop/open-external';

export const RELEASE_URL = 'https://github.com/hurttlocker/o8/releases/latest';

export interface InstallUpdateOutcome {
  /** The actual plugin result, which can differ from a previously displayed check. */
  version?: string;
  /** True when the update downloaded and installed. */
  installed: boolean;
  /** The update installed, but the caller's final safety check deferred relaunch. */
  restartDeferred?: boolean;
  /** Set when the update was skipped because the version is pulled (kill-switch). */
  blocked?: { version: string; note?: string };
  /** The install cannot self-update, so the release download was opened instead. */
  downloadOpened?: boolean;
}

export interface InstallUpdateOptions {
  beforeRestart?: (() => Promise<boolean>) & { interruptWork?: () => boolean };
  interruptWork?: () => boolean;
  /**
   * False when the running install cannot replace itself (a deb/rpm Linux
   * install — see `isSelfUpdatableInstall`). Such a call opens the release
   * download instead of ever reaching restart-to-install.
   */
  selfUpdatable?: boolean;
  /** Download and install progress, for the update panel. */
  onProgress?: (progress: UpdateProgress) => void;
}

export interface UpdateProgress {
  stage: 'downloading' | 'installing' | 'restarting';
  receivedBytes: number;
  /** Null when the server did not send a content length. */
  totalBytes: number | null;
}

/**
 * Ask the (loopback-gated) server whether `version` is pulled. FAIL-OPEN: any
 * error resolves to not-pulled so the update proceeds. The server does the
 * actual raw.githubusercontent.com fetch because the webview CSP forbids it.
 */
async function isVersionPulled(version: string): Promise<{ pulled: boolean; note?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`/api/panel/release-health?version=${encodeURIComponent(version)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) return { pulled: false };
      const payload = await res.json().catch(() => null) as { pulled?: unknown; note?: unknown } | null;
      if (payload && payload.pulled === true) {
        return { pulled: true, note: typeof payload.note === 'string' ? payload.note : undefined };
      }
      return { pulled: false };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { pulled: false }; // fail open
  }
}

/** Explicit interruption consent can bypass a CLI wait; ordinary restart checks stay final. */
async function confirmRestartAdmission(options: InstallUpdateOptions): Promise<boolean> {
  const { waitForConnectedCliUpdates } = await import('./update-hub-client');
  const force = () => (options.interruptWork?.() ?? options.beforeRestart?.interruptWork?.()) === true;
  if (force() || options.beforeRestart?.interruptWork) {
    if (options.beforeRestart && !(await options.beforeRestart())) return false;
    if (!force()) await waitForConnectedCliUpdates();
    // Native admission always inspects current work under the reservation.
    return true;
  }
  await waitForConnectedCliUpdates();
  return !options.beforeRestart || await options.beforeRestart();
}

export async function relaunchInstalledUpdate(options: InstallUpdateOptions = {}): Promise<boolean> {
  if (!(await confirmRestartAdmission(options))) return false;
  const force = (options.interruptWork?.() ?? options.beforeRestart?.interruptWork?.()) === true;
  const { invoke } = await import('@tauri-apps/api/core');
  let reservationId: string;
  try { reservationId = await invoke<string>('prepare_app_restart', { force }); }
  catch (error) { if (String(error).includes('cli_operation_blocked:')) return false; throw error; }
  if (typeof reservationId !== 'string' || !reservationId.trim()) throw new Error('Native restart reservation was not recorded.');
  try {
    await invoke('restart_app', { reservationId });
    return true;
  } catch (error) {
    await invoke('cancel_app_restart', { reservationId }).catch(() => { /* Preserve an uncertain native owner. */ });
    if (String(error).includes('cli_operation_blocked:')) return false;
    throw error;
  }
}

export async function installUpdateAndRestart(
  releaseUrl?: string,
  options: InstallUpdateOptions = {},
): Promise<InstallUpdateOutcome> {
  if (options.selfUpdatable === false) {
    openExternalUrl(releaseUrl ?? RELEASE_URL);
    return { installed: false, downloadOpened: true };
  }

  if (!isTauri()) {
    openExternalUrl(releaseUrl ?? RELEASE_URL);
    return { installed: false };
  }

  const { check } = await import('@/lib/app-update/check');
  const result = await check();
  if (!result) return { installed: false };

  // Kill-switch: skip a version the operator has pulled post-release.
  const health = await isVersionPulled(result.version);
  if (health.pulled) {
    console.warn(`[app-update] update to ${result.version} blocked by release-health kill-switch`);
    return { installed: false, blocked: { version: result.version, note: health.note } };
  }

  let receivedBytes = 0;
  let totalBytes: number | null = null;
  options.onProgress?.({ stage: 'downloading', receivedBytes, totalBytes });
  const { invoke, Channel } = await import('@tauri-apps/api/core');
  const channel = new Channel<import('@tauri-apps/plugin-updater').DownloadEvent>();
  channel.onmessage = (event) => {
    if (event.event === 'Started') totalBytes = event.data.contentLength ?? null;
    else if (event.event === 'Progress') receivedBytes += event.data.chunkLength;
    options.onProgress?.({ stage: event.event === 'Finished' ? 'installing' : 'downloading', receivedBytes, totalBytes });
  };
  const downloadedRid = await invoke<number>('download_app_update', { rid: result.rid, onEvent: channel });
  try {
    if (result.installExits) {
      // Windows exits in the native installer. Confirm against fresh work after
      // download, then pass that consent to its final native exit guard.
      if (!(await confirmRestartAdmission(options))) return { installed: false, version: result.version };
    }
    await invoke('install_app_update', { rid: downloadedRid,
      force: (options.interruptWork?.() ?? options.beforeRestart?.interruptWork?.()) === true });
  } finally {
    await invoke('discard_app_update_download', { rid: downloadedRid }).catch(() => {});
  }
  options.onProgress?.({ stage: 'restarting', receivedBytes, totalBytes });
  const restarted = await relaunchInstalledUpdate(options);
  return { installed: true, version: result.version, restartDeferred: !restarted };
}
