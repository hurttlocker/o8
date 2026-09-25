import { canUseTauriEvents } from '@/lib/tauri/bridge';

/** Browser tabs and native main windows share the same visibility contract. */
export async function isOperatorWindowVisible(): Promise<boolean> {
  if (typeof document === 'undefined' || document.visibilityState === 'hidden') return false;
  if (!canUseTauriEvents()) return true;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return await getCurrentWindow().isVisible();
  } catch {
    // Native visibility must be known before starting background discovery.
    return false;
  }
}
