/**
 * Monaco Editor polyfills — MUST be imported before monaco-editor.
 * Monaco's clipboardService.js references ClipboardItem at module scope.
 */

if (typeof window !== 'undefined') {
  const isMonacoCancellation = (value: unknown) => {
    const error = value as { message?: string; name?: string; code?: string } | null;
    return Boolean(
      error
      && (
        error.message === 'Canceled'
        || error.name === 'Canceled'
        || error.name === 'CancellationError'
        || error.code === 'Canceled'
      )
    );
  };

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
        writeText: async () => {},
        readText: async () => '',
        write: async () => {},
        read: async () => [],
      },
      configurable: true,
    });
  }

  // Override clipboard.write with a safe implementation so Monaco's speculative
  // WebKit clipboard workaround cannot surface CancellationError in dev overlay.
  const origWriteText = navigator.clipboard.writeText?.bind(navigator.clipboard);
  navigator.clipboard.write = async (data: ClipboardItems) => {
    try {
      const items = Array.from(data as unknown as Iterable<{ getType?: (type: string) => Promise<Blob | string> }>);
      for (const item of items) {
        if (!item || typeof item.getType !== 'function') continue;
        try {
          const payload = await item.getType('text/plain');
          const text = payload instanceof Blob ? await payload.text() : String(payload ?? '');
          if (origWriteText && text) {
            try {
              await origWriteText(text);
            } catch {
              // Ignore clipboard permission failures in Monaco's speculative path.
            }
          }
          break;
        } catch (error) {
          if (isMonacoCancellation(error)) {
            return undefined as never;
          }
        }
      }
      return undefined as never;
    } catch {
      // Silently fail — Monaco's clipboard service calls this speculatively
      return undefined as never;
    };
  };

  const existingOnUnhandledRejection = window.onunhandledrejection;
  window.onunhandledrejection = (event) => {
    if (isMonacoCancellation(event.reason)) {
      event.preventDefault();
      return true;
    }
    return existingOnUnhandledRejection ? existingOnUnhandledRejection.call(window, event) : false;
  };

  const existingReportError = globalThis.reportError?.bind(globalThis);
  globalThis.reportError = (error: unknown) => {
    if (isMonacoCancellation(error)) {
      return;
    }
    existingReportError?.(error);
  };

  const origAddEventListener = window.addEventListener.bind(window);
  window.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'unhandledrejection' || type === 'error') {
      const wrappedListener = (event: Event) => {
        if (type === 'unhandledrejection') {
          const reason = (event as PromiseRejectionEvent).reason;
          if (isMonacoCancellation(reason)) {
            event.preventDefault();
            return;
          }
        }
        if (type === 'error') {
          const errorEvent = event as ErrorEvent;
          if (isMonacoCancellation(errorEvent.error) || isMonacoCancellation(errorEvent.message)) {
            event.preventDefault();
            return;
          }
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
