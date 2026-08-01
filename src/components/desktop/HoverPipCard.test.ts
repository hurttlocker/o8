// @vitest-environment jsdom

import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverPipCard } from './HoverPipCard';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: 'div' },
  useReducedMotion: () => false,
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function Preview({
  eventName,
  title,
  onOpen,
}: {
  eventName: string;
  title: string;
  onOpen?: () => void;
}) {
  const props: ComponentProps<typeof HoverPipCard> = {
    active: true,
    available: true,
    eventName,
    storageKey: `${eventName}:orientation`,
    title,
    onOpen,
    children: () => createElement('div', null, `${title} body`),
  };
  return createElement(HoverPipCard, props);
}

describe('HoverPipCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it('toggles explicitly and closes the previous preview when another opens', () => {
    act(() => {
      root.render(createElement('div', null,
        createElement(Preview, { eventName: 'test:first-pip', title: 'First' }),
        createElement(Preview, { eventName: 'test:second-pip', title: 'Second' }),
      ));
    });

    act(() => window.dispatchEvent(new CustomEvent('test:first-pip', { detail: { toggle: true } })));
    expect(container.textContent).toContain('First body');
    expect(container.textContent).not.toContain('Second body');

    act(() => window.dispatchEvent(new CustomEvent('test:second-pip', { detail: { toggle: true } })));
    expect(container.textContent).not.toContain('First body');
    expect(container.textContent).toContain('Second body');

    act(() => window.dispatchEvent(new CustomEvent('test:second-pip', { detail: { toggle: true } })));
    expect(container.textContent).not.toContain('Second body');
  });

  it('persists orientation and opens the full surface from the header control', () => {
    const onOpen = vi.fn();
    act(() => root.render(createElement(Preview, {
      eventName: 'test:open-pip',
      title: 'Openable',
      onOpen,
    })));
    act(() => window.dispatchEvent(new CustomEvent('test:open-pip', { detail: { toggle: true } })));

    const orientation = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to mobile-style view"]');
    expect(orientation).not.toBeNull();
    act(() => orientation?.click());
    expect(localStorage.getItem('test:open-pip:orientation')).toBe('tall');

    const open = container.querySelector<HTMLButtonElement>('button[aria-label="Open preview"]');
    expect(open).not.toBeNull();
    act(() => open?.click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('Openable body');
  });
});
