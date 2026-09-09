import type { Event, EventCallback, EventName } from '@tauri-apps/api/event';

/**
 * The native listen response can precede the queued webview registration.
 * The event SDK looks up the callback through that late registry on release:
 * a missing row throws, while a missing event silently leaks the callback.
 * Own the core callback ID instead. Keep the same native event IPC contract,
 * and never depend on the deferred webview registry to release our callback.
 * Callers must check their window's event capability before subscribing.
 */
export async function listenTauriEvent<T>(
  eventName: EventName,
  handler: EventCallback<T>,
): Promise<() => Promise<void>> {
  const { invoke, transformCallback } = await import('@tauri-apps/api/core');
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void };
  }).__TAURI_INTERNALS__;
  const unregisterCallback = internals?.unregisterCallback;
  if (typeof unregisterCallback !== 'function') throw new Error('Native callback disposal is unavailable');
  let retired = false;
  let release: Promise<void> | null = null;
  const handlerId = transformCallback((event: Event<T>) => {
    if (!retired) handler(event);
  });
  let eventId: number;
  try {
    eventId = await invoke<number>('plugin:event|listen', {
      event: eventName, target: { kind: 'Any' }, handler: handlerId,
    });
  } catch (error) {
    retired = true;
    unregisterCallback.call(internals, handlerId);
    throw error;
  }
  return () => {
    retired = true;
    release ??= (async () => {
      try {
        await invoke('plugin:event|unlisten', { event: eventName, eventId });
      } finally {
        unregisterCallback.call(internals, handlerId);
      }
    })();
    return release;
  };
}

/** React cleanup stays synchronous; both registration and release are observed. */
export function subscribeTauriEvent<T>(eventName: EventName, handler: EventCallback<T>): () => void {
  let disposed = false;
  let unlisten: (() => Promise<void>) | null = null;
  const release = () => {
    const stop = unlisten;
    unlisten = null;
    if (stop) void stop().catch((error) => {
      console.error(`[tauri-events] release ${eventName} failed:`, error);
    });
  };
  void listenTauriEvent<T>(eventName, (event) => {
    if (!disposed) handler(event);
  }).then((stop) => {
    unlisten = stop;
    if (disposed) release();
  }).catch((error) => {
    console.error(`[tauri-events] listen ${eventName} failed:`, error);
  });
  return () => {
    disposed = true;
    release();
  };
}
