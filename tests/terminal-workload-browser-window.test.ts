import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error -- benchmark entry points are native JavaScript.
import { readPerformance } from '../scripts/bench/run-terminal-workload.mjs';

afterEach(() => vi.unstubAllGlobals());

it('normalizes browser rates against the same browser clock that owns its counters', async () => {
  vi.stubGlobal('window', { __o8TerminalPerf: {
    startedAt: 20_000, frames: 600, longTaskSupported: true,
    longTasks: [{ startTime: 21_000, duration: 100 }],
  } });
  vi.stubGlobal('performance', { now: () => 30_000 });
  const measured = await readPerformance({ evaluate: (callback: () => unknown) => callback() });
  expect(measured).toMatchObject({
    observationMs: 10_000, frameCount: 600, framesPerSecond: 60,
    longTaskCount: 1, longTaskMs: 100, longTaskMsPerMinute: 600,
  });
});

it('reports unavailable rates for a zero-length browser observation', async () => {
  vi.stubGlobal('window', { __o8TerminalPerf: {
    startedAt: 20_000, frames: 0, longTaskSupported: true, longTasks: [],
  } });
  vi.stubGlobal('performance', { now: () => 20_000 });
  const measured = await readPerformance({ evaluate: (callback: () => unknown) => callback() });
  expect(measured.framesPerSecond).toBeNull();
  expect(measured.longTaskMsPerMinute).toBeNull();
});
