// @vitest-environment jsdom

import { act, createElement, type ReactElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRightPanelPersistence } from './useRightPanelPersistence';

describe('right panel persistence', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('hydrates saved state before enabling persistence writes', async () => {
    window.localStorage.setItem('o8:right-panel:visible', '1');
    window.localStorage.setItem('o8:right-panel:kind', 'review');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    function Harness(): ReactElement {
      const [visible, setVisible] = useState(false);
      const [kind, setKind] = useState<'review' | 'o8'>('o8');
      useRightPanelPersistence({
        chatVisible: visible,
        rightPanelKind: kind,
        setChatVisible: setVisible,
        setRightPanelKind: setKind,
      });
      return createElement('div', { 'data-visible': visible, 'data-kind': kind });
    }

    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });

    expect(host.firstElementChild?.getAttribute('data-visible')).toBe('true');
    expect(host.firstElementChild?.getAttribute('data-kind')).toBe('review');
    expect(setItem).not.toHaveBeenCalledWith('o8:right-panel:visible', '0');
    expect(setItem).not.toHaveBeenCalledWith('o8:right-panel:kind', 'o8');
  });

  it('persists operator changes after hydration', async () => {
    function Harness(): ReactElement {
      const [visible, setVisible] = useState(false);
      const [kind, setKind] = useState<'review' | 'o8'>('o8');
      useRightPanelPersistence({
        chatVisible: visible,
        rightPanelKind: kind,
        setChatVisible: setVisible,
        setRightPanelKind: setKind,
      });
      return createElement('button', {
        type: 'button',
        onClick: () => {
          setVisible(true);
          setKind('review');
        },
      });
    }

    await act(async () => {
      root.render(createElement(Harness));
      await Promise.resolve();
    });
    act(() => {
      host.querySelector('button')?.click();
    });

    expect(window.localStorage.getItem('o8:right-panel:visible')).toBe('1');
    expect(window.localStorage.getItem('o8:right-panel:kind')).toBe('review');
  });
});
