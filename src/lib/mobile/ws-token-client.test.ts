// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  O8_AUTH_MODE_META,
  O8_WEB_MACHINE_SURFACE,
} from '@/lib/connect/web-machine-surface';

import { getMobileWsToken } from './ws-token-client';

afterEach(() => {
  document.head.replaceChildren();
  window.history.replaceState({}, '', '/');
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('getMobileWsToken web-machine isolation', () => {
  it('ignores and scrubs a #tk credential without persisting or reading it', () => {
    const meta = document.createElement('meta');
    meta.name = O8_AUTH_MODE_META;
    meta.content = O8_WEB_MACHINE_SURFACE;
    document.head.append(meta);
    window.history.replaceState({}, '', '/mobile#tk=remote-secret&tab=inbox');
    window.localStorage.setItem('o8:mobile-ws-token', 'stored-local-secret');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    expect(getMobileWsToken()).toBe('');
    expect(window.location.hash).toBe('#tab=inbox');
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('keeps the existing paired-phone fragment path outside web-machine mode', () => {
    window.history.replaceState({}, '', '/mobile#tk=paired-phone-token');

    expect(getMobileWsToken()).toBe('paired-phone-token');
    expect(window.location.hash).toBe('');
    expect(window.localStorage.getItem('o8:mobile-ws-token')).toBe('paired-phone-token');
  });
});
