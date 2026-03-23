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

export {};
