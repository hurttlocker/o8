// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCorrelatedActionLatch } from './use-correlated-action-latch';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('useCorrelatedActionLatch', () => {
  let host: HTMLDivElement;
  let root: Root;
  let controls: ReturnType<typeof useCorrelatedActionLatch<'merge'>> | null;

  function Harness() {
    const nextControls = useCorrelatedActionLatch<'merge'>();
    useEffect(() => { controls = nextControls; }, [nextControls]);
    return null;
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    controls = null;
    act(() => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('does not unlock an in-progress mutation without its terminal receipt', () => {
    act(() => {
      expect(controls?.begin('merge')).toBe(true);
      controls?.settle(true);
    });
    expect(controls?.busy).toBe('merge');
    expect(controls?.begin('merge')).toBe(false);
  });

  it('unlocks after a terminal success or failure receipt', () => {
    act(() => {
      expect(controls?.begin('merge')).toBe(true);
      controls?.settle(false);
    });
    expect(controls?.busy).toBeNull();
  });
});
