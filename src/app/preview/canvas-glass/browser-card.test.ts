// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserGlassCard, type BrowserCard } from './browser-card';

vi.mock('@/lib/browser-agent/page-agent', () => ({ installBrowserAgent: vi.fn() }));
vi.mock('@/components/desktop/O8EnginePane', () => ({
  O8EnginePane: ({ url, scope }: { url: string; scope: string }) => createElement('div', { 'data-engine-url': url, 'data-engine-scope': scope }),
}));
vi.mock('./card-shell', () => ({
  GlassCardShell: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const callbacks = {
  onMove: vi.fn(),
  onResize: vi.fn(),
  onFocus: vi.fn(),
  onTabsChange: vi.fn(),
  onClose: vi.fn(),
};

function renderCard(root: Root, card: BrowserCard): void {
  act(() => root.render(createElement(BrowserGlassCard, { card, ...callbacks })));
}

describe('BrowserGlassCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('mounts only the active tab and proxies local development pages', () => {
    const card: BrowserCard = {
      id: 1,
      x: 0,
      y: 0,
      z: 1,
      w: 640,
      h: 400,
      tabs: [
        { id: 1, url: 'https://example.com' },
        { id: 2, url: 'http://localhost:3000/app' },
        { id: 3, url: 'http://localhost:4000/other' },
      ],
      activeTabId: 2,
    };

    renderCard(root, card);
    let frames = container.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute('src')).toBe('/api/browser/proxy?url=http%3A%2F%2Flocalhost%3A3000%2Fapp');

    renderCard(root, { ...card, activeTabId: 3 });
    frames = container.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute('src')).toBe('/api/browser/proxy?url=http%3A%2F%2Flocalhost%3A4000%2Fother');
  });

  it('caps a 20-card canvas at one live frame per browser card', () => {
    const cards: BrowserCard[] = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      x: index * 12,
      y: index * 8,
      z: index + 1,
      w: 640,
      h: 400,
      tabs: [
        { id: 1, url: `http://localhost:3000/card-${index}` },
        { id: 2, url: `http://localhost:4000/card-${index}` },
        { id: 3, url: `https://example.com/card-${index}` },
      ],
      activeTabId: 1,
    }));

    act(() => root.render(createElement(
      'div',
      null,
      ...cards.map((card) => createElement(BrowserGlassCard, { key: card.id, card, ...callbacks })),
    )));

    expect(container.querySelectorAll('iframe')).toHaveLength(20);
  });

  it('routes external pages through an isolated interactive engine scope', () => {
    renderCard(root, {
      id: 7,
      x: 0,
      y: 0,
      z: 1,
      w: 640,
      h: 400,
      tabs: [{ id: 3, url: 'https://example.com/private-app' }],
      activeTabId: 3,
    });

    expect(container.querySelectorAll('iframe')).toHaveLength(0);
    const engine = container.querySelector<HTMLElement>('[data-engine-url]');
    expect(engine?.dataset.engineUrl).toBe('https://example.com/private-app');
    expect(engine?.dataset.engineScope).toBe('canvas-7-3');
  });
});
