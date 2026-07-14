// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { canUseTauriEvents, currentWindowLabel, isTauri } from './bridge';

// Reports on v0.1.597: a burst of `Command plugin:event|emit/listen not allowed
// by ACL` unhandled rejections crashing the renderer. Root cause: the native
// browser-view window gets __TAURI_INTERNALS__ injected (its localhost URL
// matches the capability remote.urls) so isTauri() is TRUE there, but it holds
// NO event grant. Main-app event listeners mounted in it ACL-crash. The fix:
// main-app event sites gate on canUseTauriEvents() — main window only.

function setInternals(label: string | undefined): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  // isTauri() keys on `'__TAURI_INTERNALS__' in window`, so "no Tauri" must
  // DELETE the key — assigning undefined leaves the key present (in→true).
  if (label === undefined) delete w.__TAURI_INTERNALS__;
  else w.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

describe('canUseTauriEvents — the browser-view ACL guard', () => {
  it('true only in the main window', () => {
    setInternals('main');
    expect(isTauri()).toBe(true);
    expect(currentWindowLabel()).toBe('main');
    expect(canUseTauriEvents()).toBe(true);
  });

  it('FALSE in the native browser-view even though Tauri internals are injected', () => {
    setInternals('browser-view');
    // The exact crash profile: internals present (isTauri true) but no grant.
    expect(isTauri()).toBe(true);
    expect(currentWindowLabel()).toBe('browser-view');
    expect(canUseTauriEvents()).toBe(false);
  });

  it('false outside Tauri (plain browser — no internals)', () => {
    setInternals(undefined);
    expect(isTauri()).toBe(false);
    expect(canUseTauriEvents()).toBe(false);
  });

  it('false when internals exist but the label is unreadable', () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(isTauri()).toBe(true);
    expect(currentWindowLabel()).toBe(null);
    expect(canUseTauriEvents()).toBe(false);
  });
});
