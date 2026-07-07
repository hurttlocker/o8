'use client';

const CLERK_STORE_PATH = 'clerk-store';
const STALE_IDENTITY_REASONS = new Set(['license_subject_mismatch', 'stale_session']);

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function shouldPurgeClerkStoreForEntitlementSync(reason: unknown): boolean {
  return typeof reason === 'string' && STALE_IDENTITY_REASONS.has(reason);
}

export async function purgeTauriClerkStore(): Promise<void> {
  if (!isTauriRuntime()) return;

  try {
    const [{ invoke }, { Store }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/plugin-store'),
    ]);

    await Promise.resolve(invoke('plugin:clerk|set_client_authorization_header', { header: null })).catch(() => {});
    const store = await Store.load(CLERK_STORE_PATH);
    await store.clear();
    await store.save();
    await store.close();
  } catch (error) {
    console.error('[auth] failed to purge native Clerk store:', error);
  }
}
