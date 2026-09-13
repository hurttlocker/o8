// @vitest-environment jsdom
// This test uses createElement so it remains discoverable by the source .test.ts glob.

import { act, createElement, type ReactElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRightPanelWidths } from './useRightPanelWidths';

function Harness(): ReactElement {
  const {
    rightWidth,
    setRightWidth,
    o8Width,
    setO8Width,
  } = useRightPanelWidths();

  return createElement(
    'div',
    {
      'data-chat-width': rightWidth,
      'data-o8-width': o8Width,
    },
    createElement('button', {
      'data-resize-chat': true,
      onClick: () => setRightWidth(360),
      type: 'button',
    }),
    createElement('button', {
      'data-resize-o8': true,
      onClick: () => setO8Width(640),
      type: 'button',
    }),
  );
}

describe('useRightPanelWidths', () => {
  let host: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = null;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('hydrates the stored o8 width without a markup mismatch', async () => {
    host.innerHTML = renderToString(createElement(Harness));
    expect(host.firstElementChild?.getAttribute('data-o8-width')).toBe('440');
    window.localStorage.setItem('o8:right-panel:width-o8', '600');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await act(async () => {
      root = hydrateRoot(host, createElement(Harness));
      await Promise.resolve();
    });

    const hydrationErrors = consoleError.mock.calls.filter((args) => (
      /hydrat|did not match/i.test(args.map(String).join(' '))
    ));
    expect(hydrationErrors).toEqual([]);
    expect(host.firstElementChild?.getAttribute('data-o8-width')).toBe('600');
  });

  it('hydrates the stored chat width without a markup mismatch', async () => {
    host.innerHTML = renderToString(createElement(Harness));
    expect(host.firstElementChild?.getAttribute('data-chat-width')).toBe('280');
    window.localStorage.setItem('o8:right-panel:width-chat', '600');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await act(async () => {
      root = hydrateRoot(host, createElement(Harness));
      await Promise.resolve();
    });

    const hydrationErrors = consoleError.mock.calls.filter((args) => (
      /hydrat|did not match/i.test(args.map(String).join(' '))
    ));
    expect(hydrationErrors).toEqual([]);
    expect(host.firstElementChild?.getAttribute('data-chat-width')).toBe('600');
  });

  it('persists a resized width', async () => {
    host.innerHTML = renderToString(createElement(Harness));

    await act(async () => {
      root = hydrateRoot(host, createElement(Harness));
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-resize-o8]')?.click();
    });

    expect(window.localStorage.getItem('o8:right-panel:width-o8')).toBe('640');
  });
});
