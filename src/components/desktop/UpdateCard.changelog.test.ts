// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateCard } from './UpdateCard';
import { installUpdateAndRestart } from '@/lib/app-update/client-restart';

vi.mock('@/lib/app-update/update-hub-client', () => ({
  publishAppUpdateView: vi.fn(),
  refreshCliUpdateView: vi.fn(async () => undefined),
  registerAppUpdateCheck: vi.fn(() => () => undefined),
}));
vi.mock('@/lib/app-update/client-restart', () => ({
  installUpdateAndRestart: vi.fn(),
  relaunchInstalledUpdate: vi.fn(),
  RELEASE_URL: 'https://example.test/releases',
}));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => false, canUseTauriEvents: () => false }));

const VERSION = '9.9.9';
const CHANGELOG = 'Fixture changelog: faster startup and fewer crashes.';

describe('update card changelog toggle', () => {
  let root: Root;
  let container: HTMLDivElement;

  const header = () => document.querySelector<HTMLElement>('[aria-label="Toggle update changelog"]')!;
  const region = () => {
    const id = header().getAttribute('aria-controls');
    return id ? document.getElementById(id) : null;
  };
  const press = (key: string) => act(async () => {
    header().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  // Mirrors the Settings drawer's manual check: shows the card, expanded.
  const showUpdate = () => act(async () => {
    window.dispatchEvent(new CustomEvent('o8:update-found', { detail: { version: VERSION, notes: CHANGELOG } }));
  });

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    window.localStorage.clear();
    // A cached summary keeps the changelog static, with no network fetch.
    window.localStorage.setItem('o8:update-card:summary', JSON.stringify({ [VERSION]: CHANGELOG }));
    vi.mocked(installUpdateAndRestart).mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('points aria-controls at the open changelog region that holds the changelog', async () => {
    await act(async () => root.render(createElement(UpdateCard)));
    await showUpdate();

    expect(header().getAttribute('aria-expanded')).toBe('true');
    const target = region();
    expect(target).not.toBeNull();
    expect(target!.id).toBeTruthy();
    expect(target!.textContent).toContain(CHANGELOG);
  });

  it('omits aria-controls while the changelog is closed', async () => {
    await act(async () => root.render(createElement(UpdateCard)));
    await showUpdate();
    const openId = header().getAttribute('aria-controls')!;
    await act(async () => header().click());

    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(header().hasAttribute('aria-controls')).toBe(false);
    expect(document.getElementById(openId)).toBeNull();
  });

  it('toggles with Enter and Space without starting the install', async () => {
    await act(async () => root.render(createElement(UpdateCard)));
    await showUpdate();
    expect(region()).not.toBeNull();

    await press('Enter');
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(region()).toBeNull();

    await press(' ');
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(region()?.textContent).toContain(CHANGELOG);

    expect(installUpdateAndRestart).not.toHaveBeenCalled();
  });
});