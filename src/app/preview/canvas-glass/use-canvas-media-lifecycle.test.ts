// @vitest-environment jsdom

import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoCard } from './video-card';
import { useCanvasMediaLifecycle } from './use-canvas-media-lifecycle';

const card: VideoCard = {
  id: 1,
  x: 0,
  y: 0,
  z: 1,
  w: 640,
  h: 360,
  aspect: 16 / 9,
  src: 'blob:o8-video',
  name: 'clip.mp4',
  mediaId: 'media-1',
};

function Harness(): null {
  useCanvasMediaLifecycle([card]);
  return null;
}

describe('useCanvasMediaLifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('survives the Strict Mode probe and revokes video URLs on real unmount', async () => {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Harness))));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(card.src);
  });
});
