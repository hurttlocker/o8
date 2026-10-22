'use client';

import type { Update } from '@tauri-apps/plugin-updater';

/** All desktop checks share the native timeout, privacy, and fallback policy. */
export async function check(): Promise<Update | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  let metadata: ConstructorParameters<typeof Update>[0] | null;
  try { metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>('check_app_update'); }
  catch (error) {
    void report({ updatePending: false, checkOutcome: 'failed', checkError: String(error) });
    throw error;
  }
  void report({ updatePending: Boolean(metadata), version: metadata?.version,
    checkOutcome: metadata ? 'available' : 'current', info: metadata });
  if (!metadata) return null;
  const { Update: DesktopUpdate } = await import('@tauri-apps/plugin-updater');
  return new DesktopUpdate(metadata);
}

async function report(state: Record<string, unknown>) {
  await fetch('/api/panel/app/update-state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...state, checkedAt: new Date().toISOString() }) }).catch(() => {});
}
