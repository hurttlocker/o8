// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openExternalUrl } from './open-external';

const { shellOpen, toast } = vi.hoisted(() => ({ shellOpen: vi.fn(), toast: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: shellOpen }));
vi.mock('@/components/shared/ConfirmToastHost', () => ({ toast }));

const url = 'https://github.com/hurttlocker/o8';

beforeEach(() => {
  shellOpen.mockReset().mockResolvedValue(undefined);
  toast.mockReset();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.spyOn(window, 'open').mockReturnValue(null);
});

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.restoreAllMocks();
});

it('uses the shell opener exclusively in the native webview', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  openExternalUrl(url);
  await vi.waitFor(() => expect(shellOpen).toHaveBeenCalledExactlyOnceWith(url));
  expect(window.open).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('reports shell failure without silently falling back to the native window.open no-op', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  shellOpen.mockRejectedValueOnce(new Error('opener unavailable'));
  openExternalUrl(url);
  await vi.waitFor(() => expect(toast).toHaveBeenCalledExactlyOnceWith('Could not open this link. Please try again.', 'error'));
  expect(window.open).not.toHaveBeenCalled();
});

it('retains noopener and noreferrer in browser previews without treating a null handle as failure', () => {
  // Browsers may return null for a successful noopener window as well as a
  // blocked popup. That return value cannot establish an opening failure.
  openExternalUrl(url);
  expect(window.open).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer');
  expect(shellOpen).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('reports a browser opener exception without leaking its details', () => {
  vi.mocked(window.open).mockImplementation(() => { throw new Error('opener unavailable'); });
  expect(() => openExternalUrl(url)).not.toThrow();
  expect(toast).toHaveBeenCalledExactlyOnceWith('Could not open this link. Please try again.', 'error');
  expect(shellOpen).not.toHaveBeenCalled();
});
