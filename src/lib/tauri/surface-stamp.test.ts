// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TAURI_SURFACE_STAMP } from './surface-stamp';

function runStamp(): void {
  new Function(TAURI_SURFACE_STAMP)();
}

describe('Tauri surface stamp', () => {
  beforeEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    document.documentElement.removeAttribute('data-tauri');
    document.body.removeAttribute('data-tauri');
    document.documentElement.style.background = '#1C1C1E';
    document.body.style.background = '#1C1C1E';
    vi.restoreAllMocks();
  });

  it('makes the packaged surface transparent when the runtime is already ready', () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    runStamp();

    expect(document.documentElement.dataset.tauri).toBe('true');
    expect(document.body.dataset.tauri).toBe('true');
    expect(document.documentElement.style.background).toBe('');
    expect(document.body.style.background).toBe('');
  });

  it('self-heals when the native runtime arrives after the body script', () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });

    runStamp();
    expect(document.documentElement.dataset.tauri).toBeUndefined();
    expect(callbacks).toHaveLength(1);

    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    callbacks.shift()?.(16);

    expect(document.documentElement.dataset.tauri).toBe('true');
    expect(document.body.dataset.tauri).toBe('true');
    expect(document.documentElement.style.background).toBe('');
    expect(document.body.style.background).toBe('');
  });
});
