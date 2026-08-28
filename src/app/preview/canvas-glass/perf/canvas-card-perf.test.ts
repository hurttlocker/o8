// @vitest-environment jsdom

import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANVAS_CARD_PERF_COUNTS,
  CanvasCardPerfHarness,
  createCanvasCardPerfFixture,
  type CanvasCardPerfHandle,
} from './canvas-card-perf';
import { setCanvasRenderProbe } from './render-probe';

vi.mock('@/components/desktop/workspace-terminal/XtermPanel', () => ({
  XtermPanel: () => createElement('div', { 'data-perf-xterm': true }, 'fixed terminal content'),
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

interface PerfResult {
  initialRenderMs: number;
  drag30FramesMs: number;
  maxCardsRenderedPerFrame: number;
  cardRendersPerFrame: number[];
}

async function measureCanvasCardPerf(): Promise<PerfResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const handle = createRef<CanvasCardPerfHandle>();
  const renders: string[] = [];
  const previousProbe = setCanvasRenderProbe((id) => renders.push(id));

  try {
    const initialStart = performance.now();
    act(() => root.render(createElement(CanvasCardPerfHarness, { ref: handle })));
    const initialRenderMs = performance.now() - initialStart;

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    renders.length = 0;

    const cardRendersPerFrame: number[] = [];
    const dragStart = performance.now();
    for (let frame = 1; frame <= 30; frame += 1) {
      const renderStart = renders.length;
      act(() => handle.current?.moveFirstCard(frame));
      cardRendersPerFrame.push(new Set(renders.slice(renderStart)).size);
    }
    const drag30FramesMs = performance.now() - dragStart;

    return {
      initialRenderMs,
      drag30FramesMs,
      maxCardsRenderedPerFrame: Math.max(...cardRendersPerFrame),
      cardRendersPerFrame,
    };
  } finally {
    setCanvasRenderProbe(previousProbe);
    act(() => root.unmount());
    container.remove();
  }
}

describe('canvas card performance fixture', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: 'export const fixedFixture = true;\nexport const cardCount = 20;\n',
        mtimeMs: 1,
      }),
    })));
  });

  afterEach(() => {
    setCanvasRenderProbe(null);
    vi.unstubAllGlobals();
  });

  it('spawns the fixed 20-card mixed fixture without network input', () => {
    const fixture = createCanvasCardPerfFixture();
    expect(fixture.termCards).toHaveLength(CANVAS_CARD_PERF_COUNTS.term);
    expect(fixture.fileCards).toHaveLength(CANVAS_CARD_PERF_COUNTS.file);
    expect(fixture.diffCards).toHaveLength(CANVAS_CARD_PERF_COUNTS.diff);
    expect(fixture.markdownCards).toHaveLength(CANVAS_CARD_PERF_COUNTS.markdown);
    expect(fixture.imageCards).toHaveLength(CANVAS_CARD_PERF_COUNTS.image);
    expect(Object.values(fixture).flat()).toHaveLength(CANVAS_CARD_PERF_COUNTS.total);
  });

  it('records the 20-card initial render and 30-frame drag profile', async () => {
    const result = await measureCanvasCardPerf();
    if (process.env.CANVAS_PERF_REPORT === '1') {
      console.info(`CANVAS_PERF ${JSON.stringify(result)}`);
    }
    expect(result.cardRendersPerFrame).toHaveLength(30);
    expect(result.initialRenderMs).toBeGreaterThan(0);
    expect(result.drag30FramesMs).toBeGreaterThan(0);
  });

  it('keeps a single-card move to at most two card renders', async () => {
    const result = await measureCanvasCardPerf();
    expect(result.maxCardsRenderedPerFrame).toBeLessThanOrEqual(2);
  });
});
