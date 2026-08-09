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

vi.mock('./HoverPipCard', async () => {
  const React = await import('react');
  return {
    HoverPipCard: ({ children, onOpen, available }: {
      children: (context: {
        shape: { width: number; frameHeight: number; viewport: number };
        close: () => void;
      }) => import('react').ReactNode;
      onOpen?: () => void;
      available?: boolean;
    }) => React.createElement(
      'div',
      { 'data-available': available ? 'true' : 'false' },
      React.createElement('button', {
        type: 'button',
        'aria-label': 'Open o8.md panel',
        onClick: onOpen,
      }),
      children({
        shape: { width: 300, frameHeight: 470, viewport: 390 },
        close: () => undefined,
      }),
    ),
  };
});

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('O8SpecPipCard editor interaction', () => {
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

  it('keeps the editor interactive and expands only from the header control', () => {
    const onOpenSpec = vi.fn();
    act(() => root.render(createElement(O8SpecPipCard, {
      active: true,
      repoPath: '/workspace/o8',
      onOpenSpec,
    })));

    const scroller = container.querySelector<HTMLElement>('.o8-notes-scroll');
    const expandButtons = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Open o8.md panel"]');
    expect(scroller).not.toBeNull();
    expect(scroller?.closest('[aria-hidden="true"]')).toBeNull();
    expect(expandButtons).toHaveLength(1);

    act(() => scroller?.click());
    expect(onOpenSpec).not.toHaveBeenCalled();

    act(() => expandButtons[0]?.click());
    expect(onOpenSpec).toHaveBeenCalledOnce();
  });

  it('keeps the picker surface available when no project repo is active', () => {
    act(() => root.render(createElement(O8SpecPipCard, {
      active: true,
      repoPath: null,
    })));

    expect(container.querySelector('[data-available="true"]')).not.toBeNull();
    expect(container.querySelector('.o8-notes-scroll')).not.toBeNull();
  });
});
