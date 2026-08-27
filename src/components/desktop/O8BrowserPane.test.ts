// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_PANE_STATE_VERSION,
  BROWSER_PANE_STORAGE_KEY,
  getBrowserPaneTabs,
  type BrowserTab,
} from '@/lib/browser/pane-state';
import { O8BrowserPane } from './O8BrowserPane';

const browserRuntime = vi.hoisted(() => ({ nativeEnabled: false, inTauri: false }));

vi.mock('@/lib/browser-agent/page-agent', () => ({ installBrowserAgent: vi.fn() }));
vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/operator/use-native-browser-view', () => ({
  useNativeBrowserViewFlag: () => browserRuntime.nativeEnabled,
}));
vi.mock('@/lib/tauri/bridge', () => ({
  isTauri: () => browserRuntime.inTauri,
  browserViewEval: vi.fn(async () => undefined),
  browserViewNavigate: vi.fn(async () => undefined),
}));
vi.mock('./O8EnginePane', async () => {
  const { createElement: element } = await import('react');
  return {
    O8EnginePane: ({ url }: { url: string }) => element('div', { 'data-testid': 'engine-surface' }, url),
  };
});
vi.mock('./NativeBrowserSurface', async () => {
  const { createElement: element } = await import('react');
  return {
    NativeBrowserSurface: ({ url }: { url: string }) => element('div', { 'data-testid': 'native-surface' }, url),
  };
});

function seedDurableScope(scopeKey: string, tabs: BrowserTab[], activeTabId: string | null): void {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  localStorage.setItem(BROWSER_PANE_STORAGE_KEY, JSON.stringify({
    version: BROWSER_PANE_STATE_VERSION,
    scopes: [{
      scopeKey,
      updatedAt: Date.now(),
      tabs,
      activeTabId: active?.id ?? null,
      activeUrl: active?.url ?? null,
    }],
  }));
}

function dataTransferStub() {
  return { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };
}

describe('O8BrowserPane durable entry path', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    browserRuntime.nativeEnabled = false;
    browserRuntime.inTauri = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it('hydrates before preview seeding and restores an engine surface exactly once', async () => {
    const scopeKey = `browser-restart-${Date.now()}`;
    seedDurableScope(scopeKey, [
      { id: 'offline', url: 'http://localhost:4999/', title: 'Offline preview', surface: 'embedded' },
      { id: 'engine', url: 'https://example.com/app', title: 'Remote app', surface: 'engine' },
    ], 'engine');

    await act(async () => {
      root.render(createElement(O8BrowserPane, {
        stateScopeKey: scopeKey,
        previews: [{ id: 'preview', tabId: 'preview-tab', url: 'http://localhost:4999/', port: 4999, detectedAt: Date.now() }],
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="engine-surface"]')?.textContent).toBe('https://example.com/app');
    const offlineTab = container.querySelector<HTMLElement>('[title="Offline preview"]');
    expect(offlineTab).not.toBeNull();
    expect(getBrowserPaneTabs(scopeKey).map((tab) => tab.id)).toEqual(['offline', 'engine']);

    await act(async () => {
      offlineTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('iframe')?.getAttribute('src')).toContain('/api/browser/proxy?url=');
  });

  it('does not resurrect previews after the operator deliberately closes the scope', async () => {
    const scopeKey = `browser-empty-${Date.now()}`;
    seedDurableScope(scopeKey, [], null);

    await act(async () => {
      root.render(createElement(O8BrowserPane, {
        stateScopeKey: scopeKey,
        previews: [{ id: 'preview', tabId: 'preview-tab', url: 'http://localhost:4888/', port: 4888, detectedAt: Date.now() }],
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('No active previews');
    expect(getBrowserPaneTabs(scopeKey)).toHaveLength(0);
  });

  it('restores the native surface when the packaged host owns browser rendering', async () => {
    browserRuntime.nativeEnabled = true;
    browserRuntime.inTauri = true;
    const scopeKey = `browser-native-${Date.now()}`;
    seedDurableScope(scopeKey, [
      { id: 'native', url: 'https://example.org/docs', title: 'Docs', surface: 'native' },
    ], 'native');

    await act(async () => {
      root.render(createElement(O8BrowserPane, { stateScopeKey: scopeKey }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="native-surface"]')?.textContent).toBe('https://example.org/docs');
  });

  it('renders a navigation placeholder instead of replaying a redacted address', async () => {
    const scopeKey = `browser-redacted-${Date.now()}`;
    seedDurableScope(scopeKey, [
      { id: 'redacted', url: '', title: 'Navigation required', surface: 'engine', redacted: true },
    ], 'redacted');

    await act(async () => {
      root.render(createElement(O8BrowserPane, { stateScopeKey: scopeKey }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Navigate again to reopen this page');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('persists drag reordering through the pane state seam', async () => {
    const scopeKey = `browser-reorder-${Date.now()}`;
    seedDurableScope(scopeKey, [
      { id: 'one', url: 'https://example.com/one', title: 'One', surface: 'embedded' },
      { id: 'two', url: 'https://example.com/two', title: 'Two', surface: 'embedded' },
      { id: 'three', url: 'https://example.com/three', title: 'Three', surface: 'embedded' },
    ], 'one');

    await act(async () => {
      root.render(createElement(O8BrowserPane, { stateScopeKey: scopeKey }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const first = container.querySelector<HTMLElement>('[title="One"]');
    const third = container.querySelector<HTMLElement>('[title="Three"]');
    expect(first).not.toBeNull();
    expect(third).not.toBeNull();

    await act(async () => {
      const dragStart = new Event('dragstart', { bubbles: true });
      Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransferStub() });
      first!.dispatchEvent(dragStart);
      const drop = new MouseEvent('drop', { bubbles: true, clientX: 1 });
      Object.defineProperty(drop, 'dataTransfer', { value: dataTransferStub() });
      third!.dispatchEvent(drop);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getBrowserPaneTabs(scopeKey).map((tab) => tab.id)).toEqual(['two', 'three', 'one']);
  });
});
