'use client';

import { isTauri } from '@/lib/tauri/bridge';
import { openExternalUrl } from '@/lib/desktop/open-external';

export const RELEASE_URL = 'https://github.com/hurttlocker/o8/releases/latest';

export async function installUpdateAndRestart(releaseUrl?: string): Promise<boolean> {
  if (!isTauri()) {
    openExternalUrl(releaseUrl ?? RELEASE_URL);
    return false;
  }

  const { check } = await import('@tauri-apps/plugin-updater');
  const result = await check();
  if (!result) return false;

  await result.downloadAndInstall();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('restart_app');
  } catch {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }
  return true;
}
