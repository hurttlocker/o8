'use client';

import type { Update } from '@tauri-apps/plugin-updater';

/** All desktop checks share the native timeout, privacy, and fallback policy. */
export async function check(): Promise<Update | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>('check_app_update');
  if (!metadata) return null;
  const { Update: DesktopUpdate } = await import('@tauri-apps/plugin-updater');
  return new DesktopUpdate(metadata);
}
