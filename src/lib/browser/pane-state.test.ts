/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PaneStateModule = typeof import('./pane-state');

async function freshPaneState(): Promise<PaneStateModule> {
  vi.resetModules();
  return import('./pane-state');
}

describe('durable browser pane state', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('restores ordered tabs, active selection, and routing metadata across a module restart', async () => {
    let state = await freshPaneState();
    state.writeBrowserPaneState('repo-a', [
      { id: 'a-embedded', url: 'http://localhost:4100/', title: 'Preview', surface: 'embedded' },
      { id: 'a-engine', url: 'https://example.com/app', title: 'Remote app', surface: 'engine' },
      { id: 'a-native', url: 'https://example.org/docs', title: 'Docs', surface: 'native' },
    ], 'a-engine');
    state.writeBrowserPaneState('repo-b', [
      { id: 'b-local', url: 'http://localhost:4200/', title: 'Second preview', surface: 'embedded' },
    ], 'b-local');

    state = await freshPaneState();
    expect(state.readBrowserPaneState('repo-a')).toEqual({
      tabs: [
        { id: 'a-embedded', url: 'http://localhost:4100/', title: 'Preview', surface: 'embedded', redacted: false },
        { id: 'a-engine', url: 'https://example.com/app', title: 'Remote app', surface: 'engine', redacted: false },
        { id: 'a-native', url: 'https://example.org/docs', title: 'Docs', surface: 'native', redacted: false },
      ],
      activeTabId: 'a-engine',
      activeUrl: 'https://example.com/app',
    });
    expect(state.readBrowserPaneState('repo-b')?.tabs).toHaveLength(1);
  });

  it('keeps a closed tab closed after the next restart', async () => {
    let state = await freshPaneState();
    const tabs = [
      { id: 'one', url: 'https://example.com/one', title: 'One' },
      { id: 'two', url: 'https://example.com/two', title: 'Two' },
      { id: 'three', url: 'https://example.com/three', title: 'Three' },
    ];
    state.writeBrowserPaneState('close-scope', tabs, 'two');
    state.writeBrowserPaneState('close-scope', tabs.filter((tab) => tab.id !== 'two'), 'three');

    state = await freshPaneState();
    const restored = state.readBrowserPaneState('close-scope');
    expect(restored?.tabs.map((tab) => tab.id)).toEqual(['one', 'three']);
    expect(restored?.activeTabId).toBe('three');
  });

  it('never persists userinfo, sensitive query values, or fragments', async () => {
    let state = await freshPaneState();
    state.writeBrowserPaneState('security-scope', [
      {
        id: 'sensitive',
        url: 'https://operator:password@example.com/report?view=grid&access_token=top-secret#private-fragment',
        title: 'Sensitive report',
        surface: 'engine',
      },
      {
        id: 'safe',
        url: 'https://example.org/search?q=durability#section-two',
        title: 'Safe search',
        surface: 'embedded',
      },
      {
        id: 'api-key',
        url: 'https://example.net/data?apiKey=another-secret-value',
        title: 'API data',
        surface: 'native',
      },
    ], 'sensitive');

    const raw = localStorage.getItem(state.BROWSER_PANE_STORAGE_KEY) ?? '';
    expect(raw).not.toContain('operator');
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('top-secret');
    expect(raw).not.toContain('private-fragment');
    expect(raw).not.toContain('section-two');
    expect(raw).not.toContain('another-secret-value');
    expect(raw).toContain('q=durability');

    state = await freshPaneState();
    const restored = state.readBrowserPaneState('security-scope');
    expect(restored?.tabs[0]).toMatchObject({
      id: 'sensitive',
      url: '',
      title: 'Navigation required',
      redacted: true,
      surface: 'engine',
    });
    expect(restored?.tabs[1]?.url).toBe('https://example.org/search?q=durability');
    expect(restored?.tabs[2]).toMatchObject({ url: '', redacted: true, surface: 'native' });
  });

  it('rejects unknown and corrupt snapshots without crashing', async () => {
    let state = await freshPaneState();
    localStorage.setItem(state.BROWSER_PANE_STORAGE_KEY, JSON.stringify({ version: 99, scopes: [] }));
    expect(state.readBrowserPaneState('unknown-version')).toBeNull();
    expect(localStorage.getItem(state.BROWSER_PANE_STORAGE_KEY)).toBeNull();

    state = await freshPaneState();
    localStorage.setItem(state.BROWSER_PANE_STORAGE_KEY, '{broken');
    expect(state.readBrowserPaneState('corrupt')).toBeNull();
    expect(localStorage.getItem(state.BROWSER_PANE_STORAGE_KEY)).toBeNull();
  });

  it('caps the durable ledger to the most recently touched scopes', async () => {
    const state = await freshPaneState();
    for (let index = 0; index < state.BROWSER_PANE_MAX_SCOPES + 3; index += 1) {
      vi.setSystemTime(new Date(Date.parse('2026-08-27T12:00:00.000Z') + index * 1_000));
      state.writeBrowserPaneState(`scope-${index}`, [{
        id: `tab-${index}`,
        url: `https://example.com/${index}`,
        title: `Tab ${index}`,
      }], `tab-${index}`);
    }

    const stored = JSON.parse(localStorage.getItem(state.BROWSER_PANE_STORAGE_KEY) ?? '{}') as {
      scopes?: Array<{ scopeKey: string }>;
    };
    expect(stored.scopes).toHaveLength(state.BROWSER_PANE_MAX_SCOPES);
    expect(stored.scopes?.[0]?.scopeKey).toBe(`scope-${state.BROWSER_PANE_MAX_SCOPES + 2}`);
    expect(stored.scopes?.some((scope) => scope.scopeKey === 'scope-0')).toBe(false);
  });

  it('reorders a tab before or after a target without changing identity', async () => {
    const state = await freshPaneState();
    const tabs = [
      { id: 'one', url: 'https://example.com/one', title: 'One' },
      { id: 'two', url: 'https://example.com/two', title: 'Two' },
      { id: 'three', url: 'https://example.com/three', title: 'Three' },
    ];
    expect(state.reorderBrowserTabs(tabs, 'one', 'three', 'after').map((tab) => tab.id))
      .toEqual(['two', 'three', 'one']);
    expect(state.reorderBrowserTabs(tabs, 'three', 'one', 'before').map((tab) => tab.id))
      .toEqual(['three', 'one', 'two']);
  });
});
