'use client';

import { isTauri } from '@/lib/tauri/bridge';
import { openExternalUrl } from '@/lib/desktop/open-external';

export const RELEASE_URL = 'https://github.com/hurttlocker/o8/releases/latest';

export interface InstallUpdateOutcome {
  /** True when the update downloaded and installed. */
  installed: boolean;
  /** The update installed, but the caller's final safety check deferred relaunch. */
  restartDeferred?: boolean;
  /** Set when the update was skipped because the version is pulled (kill-switch). */
  blocked?: { version: string; note?: string };
}

export interface InstallUpdateOptions {
  beforeRestart?: () => Promise<boolean>;
}

async function releaseCloudJobLeasesForRestart(): Promise<void> {
  await fetch('/api/panel/cloud-jobs/drain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finalize: true }),
  }).catch((error) => {
    console.warn('[app-update] cloud job drain unavailable; lease expiry remains the recovery boundary', error);
  });
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

export async function relaunchInstalledUpdate(options: InstallUpdateOptions = {}): Promise<boolean> {
  if (options.beforeRestart && !(await options.beforeRestart())) return false;
  await releaseCloudJobLeasesForRestart();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('restart_app');
  } catch {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }
  return true;
}

export async function installUpdateAndRestart(
  releaseUrl?: string,
  options: InstallUpdateOptions = {},
): Promise<InstallUpdateOutcome> {
  if (!isTauri()) {
    openExternalUrl(releaseUrl ?? RELEASE_URL);
    return { installed: false };
  }

  const { check } = await import('@tauri-apps/plugin-updater');
  const result = await check();
  if (!result) return { installed: false };

  // Kill-switch: skip a version the operator has pulled post-release.
  const health = await isVersionPulled(result.version);
  if (health.pulled) {
    console.warn(`[app-update] update to ${result.version} blocked by release-health kill-switch`);
    return { installed: false, blocked: { version: result.version, note: health.note } };
  }

  await result.downloadAndInstall();
  const restarted = await relaunchInstalledUpdate(options);
  return { installed: true, restartDeferred: !restarted };
}
