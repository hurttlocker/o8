import type { Submenu } from '@tauri-apps/api/menu';
import { canUseTauriEvents } from '@/lib/tauri/bridge';

const OPEN_FEEDBACK_EVENT = 'o8:open-manual-feedback';
const installations = new WeakMap<object, Promise<void>>();

export function canInstallFeedbackMenu(): boolean {
  return canUseTauriEvents() && (window as unknown as { __O8_HOST_PLATFORM__?: unknown }).__O8_HOST_PLATFORM__ === 'macos';
}

/** Return whether the app-wide host handled the request. Settings previews keep their local fallback. */
export function requestFeedbackSheet(): boolean {
  return !window.dispatchEvent(new Event(OPEN_FEEDBACK_EVENT, { cancelable: true }));
}

export function subscribeFeedbackSheet(open: () => void): () => void {
  const handle = (event: Event) => { event.preventDefault(); open(); };
  window.addEventListener(OPEN_FEEDBACK_EVENT, handle);
  return () => window.removeEventListener(OPEN_FEEDBACK_EVENT, handle);
}

/** One app-lifetime menu action per native webview runtime, independent of React remounts. */
export function ensureNativeFeedbackMenu(): Promise<void> {
  if (!canInstallFeedbackMenu()) return Promise.resolve();
  const runtime = (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__;
  const pending = installations.get(runtime);
  if (pending) return pending;
  const installation = install().catch((error) => { installations.delete(runtime); throw error; });
  installations.set(runtime, installation);
  return installation;
}

async function install(): Promise<void> {
  const { Menu, MenuItem } = await import('@tauri-apps/api/menu');
  if (!canInstallFeedbackMenu()) return;
  const handles: { close: () => Promise<void> }[] = [];
  try {
    const menu = await Menu.default();
    handles.push(menu);
    const entries = await menu.items();
    handles.push(...entries);
    let help: Submenu | null = null;
    for (const entry of entries) {
      if (entry.kind === 'Submenu' && await entry.text() === 'Help') { help = entry as Submenu; break; }
    }
    if (!help) throw new Error('The native default Help menu is unavailable.');
    const feedback = await MenuItem.new({
      id: 'o8-send-feedback', text: 'Send Feedback…',
      // The native action owns no React callback. A remounted host receives
      // this local request; an unmounted or capability-less page does not.
      action: () => { if (canInstallFeedbackMenu()) requestFeedbackSheet(); },
    });
    handles.push(feedback);
    await help.append(feedback);
    if (!canInstallFeedbackMenu()) return;
    const previous = await menu.setAsAppMenu();
    if (previous) handles.push(previous);
  } finally {
    // The app owns the installed menu. Release only the SDK resource handles,
    // including enumerated submenus and the returned previous-menu handle.
    const results = await Promise.allSettled(handles.map(handle => handle.close()));
    const failed = results.filter(result => result.status === 'rejected').length;
    if (failed) console.error('[feedback-menu] Native handle release failed:', failed);
  }
}
