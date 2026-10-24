import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { WsWatchdog } from './health-watchdog';
import { withWsHealthHandler, wsInFlightHandlers } from './handler-activity';

it('attributes a completed handler to its delayed watchdog gap and releases rejected handlers', async () => {
  let clock = performance.now();
  const watchdog = new WsWatchdog({ intervalMs: 10, sustainedSamples: 1, cpuSampler: false,
    nowMs: () => clock, scheduler: () => ({}), cancelScheduler: () => {}, log: () => {} });
  watchdog.start();
  await withWsHealthHandler('merge', async () => {
    expect(wsInFlightHandlers()).toEqual(['merge']);
    clock += 600;
  });
  watchdog.tick();
  expect(watchdog.getStats()).toMatchObject({ wedgeCount: 1, lastWedgeHandlers: ['merge'], inFlightHandlers: [] });
  await expect(withWsHealthHandler('dispatch', async () => { throw new Error('fixture refusal'); })).rejects.toThrow('fixture refusal');
  expect(wsInFlightHandlers()).toEqual([]);
  // Callers receive copies; a health response cannot modify the retained record.
  watchdog.getStats().lastWedgeHandlers.length = 0;
  expect(watchdog.getStats().lastWedgeHandlers).toEqual(['merge']);
  watchdog.stop();
});
