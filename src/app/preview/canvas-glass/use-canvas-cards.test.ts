// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TermCard } from './terminal-card';
import { useCanvasCards } from './use-canvas-cards';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('useCanvasCards', () => {
  let container: HTMLDivElement;
  let root: Root;
  let cardsHook: ReturnType<typeof useCanvasCards>;

  function Probe() {
    const current = useCanvasCards();
    useEffect(() => {
      cardsHook = current;
    }, [current]);
    return null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('preserves relative z order when focus renormalizes a populated card band', () => {
    const cards: TermCard[] = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      requestId: `term-${index + 1}`,
      sessionName: null,
      exited: false,
      live: false,
      revealHold: false,
      x: index,
      y: index,
      w: 560,
      h: 300,
      z: 100 + index,
      cwd: null,
      cwdLabel: null,
    }));

    act(() => cardsHook.setTermCards(cards));
    const orderBefore = [...cardsHook.termCards].sort((a, b) => a.z - b.z).map((card) => card.id);
    cardsHook.zPeakRef.current = 38;

    act(() => {
      let attempts = 0;
      while (cardsHook.zPeakRef.current <= 38 && attempts < 40) {
        cardsHook.focusCard('term', 20);
        attempts += 1;
      }
    });

    const orderAfter = [...cardsHook.termCards].sort((a, b) => a.z - b.z).map((card) => card.id);
    const focused = cardsHook.termCards.find((card) => card.id === 20);
    expect(orderAfter).toEqual([...orderBefore.filter((id) => id !== 20), 20]);
    expect(focused?.z).toBe(Math.max(...cardsHook.termCards.map((card) => card.z)));
    expect(cardsHook.zPeakRef.current).toBe(10 + cardsHook.termCards.length);
  });
});
