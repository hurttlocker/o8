// @vitest-environment jsdom

import { act, createElement, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
    }) => {
      const domProps = { ...props };
      delete domProps.initial;
      delete domProps.animate;
      delete domProps.exit;
      delete domProps.transition;
      return createElement('div', domProps, children);
    },
  },
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const callbacks = {
  onClose: vi.fn(),
  onSelectIssue: vi.fn(),
  onSelectFile: vi.fn(),
  onSelectAgent: vi.fn(),
  onSelectChat: vi.fn(),
  onSelectPacket: vi.fn(),
  onSelectInbox: vi.fn(),
  onSelectDirective: vi.fn(),
};

describe('CommandPalette file mode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('selects a supplied repository path once', async () => {
    await act(async () => {
      root.render(createElement(CommandPalette, {
        open: true,
        initialScope: 'file',
        fileItems: [{ path: '/repo/src/page.tsx', title: 'page.tsx', detail: 'src/page.tsx' }],
        ...callbacks,
      }));
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>('input');
    expect(input?.placeholder).toBe('Search files by name...');
    const fileButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('page.tsx'));
    expect(fileButton).toBeDefined();
    act(() => fileButton?.click());

    expect(callbacks.onSelectFile).toHaveBeenCalledOnce();
    expect(callbacks.onSelectFile).toHaveBeenCalledWith('/repo/src/page.tsx', undefined);
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });
});
