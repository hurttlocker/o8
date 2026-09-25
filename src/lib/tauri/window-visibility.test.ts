// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOperatorWindowVisible } from './window-visibility';

const { isVisible } = vi.hoisted(() => ({ isVisible: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ isVisible }),
}));

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  isVisible.mockReset();
});

describe('operator window visibility', () => {
  it('pauses browser work while the document is hidden', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    expect(await isOperatorWindowVisible()).toBe(false);
    expect(isVisible).not.toHaveBeenCalled();
  });

  it('checks native visibility even when the document still reports visible', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
    };
    isVisible.mockResolvedValue(false);
    expect(await isOperatorWindowVisible()).toBe(false);
    expect(isVisible).toHaveBeenCalledTimes(1);
  });
});
