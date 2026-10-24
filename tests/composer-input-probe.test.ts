// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error -- browser instrumentation is intentionally plain JavaScript.
import { observeComposerKeystroke } from '../scripts/bench/interactions/page-instrumentation.mjs';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([0, 150])('acknowledges the first frame after paint and retains %s ms of handler delay', async delay => {
  let now = 100;
  let frames: FrameRequestCallback[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const input = document.createElement('textarea'); document.body.append(input);
  let finished = false;
  const pending = observeComposerKeystroke('textarea').then((result: { durationMs: number }) => { finished = true; return result; });
  const key = new KeyboardEvent('keydown', { key: 'x', bubbles: true });
  Object.defineProperty(key, 'timeStamp', { value: now }); input.dispatchEvent(key);
  now += delay; input.value = 'x'; input.dispatchEvent(new Event('input', { bubbles: true }));
  const frame = async () => {
    now += 16.7; const callbacks = frames; frames = [];
    callbacks.forEach(callback => callback(now)); await Promise.resolve(); await Promise.resolve();
  };
  await frame(); await frame();
  const firstPaintAcknowledged = finished;
  while (frames.length) await frame();
  const result = await pending;
  console.info('[input-probe] injected=%d frames-after-input=%d duration=%d', delay, firstPaintAcknowledged ? 2 : 3, result.durationMs);
  expect(firstPaintAcknowledged).toBe(true);
  expect(result.durationMs).toBeCloseTo(delay + 33.4, 1);
});
