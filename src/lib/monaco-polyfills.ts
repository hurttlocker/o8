/**
 * Monaco Editor polyfills — MUST be imported before monaco-editor.
 * Monaco's clipboardService.js references ClipboardItem at module scope.
 */

if (typeof window !== 'undefined') {
  // Polyfill ClipboardItem
  if (typeof globalThis.ClipboardItem === 'undefined') {
    (globalThis as Record<string, unknown>).ClipboardItem = class ClipboardItem {
      readonly types: string[];
      private items: Record<string, Blob | Promise<Blob>>;
      constructor(items: Record<string, Blob | Promise<Blob>>) {
        this.items = items;
        this.types = Object.keys(items);
      }
      getType(type: string) { return Promise.resolve(this.items[type]); }
    };
  }

  // Polyfill navigator.clipboard
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (_text: string) => {},
        readText: async () => '',
        write: async (_data: unknown[]) => {},
        read: async () => [],
      },
      configurable: true,
    });
  }

  // Patch clipboard.write to handle missing ClipboardItem gracefully
  const origWrite = navigator.clipboard.write?.bind(navigator.clipboard);
  if (origWrite) {
    navigator.clipboard.write = async (data: ClipboardItems) => {
      try {
        return await origWrite(data);
      } catch {
        // Silently fail — Monaco's clipboard service calls this speculatively
        return undefined as never;
      }
    };
  }
}

// Suppress Monaco's internal cancellation errors (async.js cancel → clipboardService)
if (typeof window !== 'undefined') {
  const origAddEventListener = window.addEventListener.bind(window);
  window.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'unhandledrejection') {
      const wrappedListener = (event: Event) => {
        const reason = (event as PromiseRejectionEvent).reason;
        if (reason?.message === 'Canceled' || reason?.name === 'Canceled') {
          event.preventDefault();
          return;
        }
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      };
      return origAddEventListener(type, wrappedListener, options);
    }
    return origAddEventListener(type, listener, options);
  };
}

export {};
