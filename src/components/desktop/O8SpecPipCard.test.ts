// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { O8SpecPipCard } from './O8SpecPipCard';

vi.mock('next/dynamic', async () => {
  const React = await import('react');
  return {
    default: () => function MockSpecPane() {
      return React.createElement('div', { className: 'o8-notes-scroll' });
    },
  };
});

vi.mock('./HoverPipCard', () => {
  return {
    HoverPipCard: ({ children }: {
      children: (context: {
        shape: { width: number; frameHeight: number; viewport: number };
        close: () => void;
      }) => import('react').ReactNode;
    }) => children({
      shape: { width: 300, frameHeight: 470, viewport: 390 },
      close: () => undefined,
    }),
  };
});

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('O8SpecPipCard preview scrolling', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('forwards wheel and keyboard scrolling to the read-only notes surface', () => {
    const onOpenSpec = vi.fn();
    act(() => root.render(createElement(O8SpecPipCard, {
      active: true,
      repoPath: '/workspace/o8',
      onOpenSpec,
    })));

    const scroller = container.querySelector<HTMLElement>('.o8-notes-scroll');
    const preview = container.querySelector<HTMLButtonElement>('button[aria-label="Open o8.md panel"]');
    expect(scroller).not.toBeNull();
    expect(preview).not.toBeNull();

    const wheel = new WheelEvent('wheel', {
      deltaY: 120,
      bubbles: true,
      cancelable: true,
    });
    act(() => preview?.dispatchEvent(wheel));
    expect(scroller?.scrollTop).toBe(120);

    const arrowDown = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    act(() => preview?.dispatchEvent(arrowDown));
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(scroller?.scrollTop).toBe(160);

    act(() => preview?.click());
    expect(onOpenSpec).toHaveBeenCalledOnce();
  });
});
