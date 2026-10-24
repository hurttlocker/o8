import type { Profiler } from 'node:inspector';
import type { Session } from 'node:inspector/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { summarizeWsCpuProfile, WsCpuSampler } from './cpu-evidence';
import { WsWatchdog } from './health-watchdog';

const root = process.cwd();
function node(id: number, url: string, functionName = 'handler', children: number[] = []): Profiler.ProfileNode {
  return { id, children, callFrame: { functionName, scriptId: String(id), url, lineNumber: id, columnNumber: 0 } };
}
function profile(): Profiler.Profile {
  const nodes = [node(1, pathToFileURL(join(root, 'src/handler.ts')).href, 'handleWork', [2]), node(2, 'node:crypto', 'native')];
  for (let id = 3; id <= 15; id++) nodes.push(node(id, pathToFileURL(join(root, `src/handler-${id}.ts`)).href));
  nodes.push(node(20, pathToFileURL('/outside/private-credential.ts').href),
    node(21, `${pathToFileURL(join(root, 'src/private.ts')).href}?token=private`),
    node(22, 'https://example.invalid/private'));
  return { nodes, samples: [2, ...nodes.slice(2).map((n) => n.id)], timeDeltas: [500000, ...nodes.slice(2).map(() => 1)], startTime: 0, endTime: 500100 };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each([undefined, '0', 'false', 'true', '1'])('starts the default profiler only for O8_WS_CPU_EVIDENCE=1 (received %s)', (value) => {
  vi.useFakeTimers();
  vi.stubEnv('O8_WS_CPU_EVIDENCE', value);
  const start = vi.spyOn(WsCpuSampler.prototype, 'start').mockImplementation(() => {});
  vi.spyOn(WsCpuSampler.prototype, 'stop').mockResolvedValue();
  const watchdog = new WsWatchdog();
  watchdog.start();
  expect(start).toHaveBeenCalledTimes(value === '1' ? 1 : 0);
  expect(watchdog.getStats().cpuEvidence).toEqual({ status: value === '1' ? 'sampling' : 'unavailable', frames: [] });
  watchdog.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds output and charges native work once to its nearest repository caller', () => {
  const evidence = summarizeWsCpuProfile(profile(), root, 100, 200);
  expect(evidence).toMatchObject({ status: 'sampled', windowStartedAt: 100, capturedAt: 200 });
  expect(evidence.frames).toHaveLength(8);
  expect(evidence.frames[0]).toEqual({ file: 'src/handler.ts', functionName: 'handleWork', line: 2, sampledMicros: 500000 });
  expect(evidence.frames.reduce((total, frame) => total + frame.sampledMicros, 0)).toBe(500007);
  expect(JSON.stringify(evidence)).not.toMatch(/outside|private|token|https|file:|node:|\/Users\//);
});
it('returns no repository attribution when samples contain only unknown/native frames', () => {
  const evidence = summarizeWsCpuProfile({ nodes: [node(1, 'node:crypto')], samples: [1], timeDeltas: [100], startTime: 0, endTime: 100 }, root, 1, 2);
  expect(evidence).toMatchObject({ status: 'sampled', frames: [], sampleCount: 1 });
});
it.each(['ws-server.mjs', 'ws-server-impl.mjs'])('attributes only the exact executing %s bundle outside the working directory', (name) => {
  const bundle = `/fixture/app/server/${name}`;
  const evidence = summarizeWsCpuProfile({ nodes: [node(1, pathToFileURL(bundle).href), node(2, pathToFileURL('/other/ws-server.mjs').href)],
    samples: [1, 2], timeDeltas: [100, 200], startTime: 0, endTime: 300 }, '/fixture/workspace', 1, 2, bundle);
  expect(evidence.frames).toEqual([{ file: name, functionName: 'handler', line: 2, sampledMicros: 100 }]);
});
it('rotates one profiler window and stops sampling and its timer on shutdown', async () => {
  vi.useFakeTimers();
  const post = vi.fn(async (method: string) => method === 'Profiler.stop' ? { profile: profile() } : {});
  const disconnect = vi.fn();
  const sampler = new WsCpuSampler(root, { connect: vi.fn(), post, disconnect } as unknown as Session);
  sampler.start();
  expect((await sampler.capture()).status).toBe('sampled');
  expect(post).toHaveBeenCalledWith('Profiler.setSamplingInterval', { interval: 10000 });
  const before = post.mock.calls.filter(([method]) => method === 'Profiler.stop').length;
  await vi.advanceTimersByTimeAsync(15000);
  expect(post.mock.calls.filter(([method]) => method === 'Profiler.stop')).toHaveLength(before + 1);
  const snapshot = sampler.getEvidence();
  snapshot.frames.length = 0;
  expect(sampler.getEvidence().frames).toHaveLength(8);
  await sampler.stop();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(sampler.getEvidence()).toEqual({ status: 'stopped', frames: [] });
  const calls = post.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(post).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
});
it('reports unavailable capture without publishing inspector errors or retaining a timer', async () => {
  vi.useFakeTimers();
  const sampler = new WsCpuSampler(root, { connect: () => { throw new Error('private error /Users/fixture/credential'); }, disconnect: vi.fn() } as unknown as Session);
  sampler.start();
  expect(await sampler.capture()).toEqual({ status: 'unavailable', frames: [] });
  expect(vi.getTimerCount()).toBe(0);
  await sampler.stop();
});
it.each([true, false])('includes a periodically rotated window only while it overlaps the delayed gap: %s', async (overlapping) => {
  vi.useFakeTimers();
  let stops = 0;
  const post = vi.fn(async (method: string) => method === 'Profiler.stop'
    ? { profile: stops++ === 0 ? profile() : { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 0 } } : {});
  const sampler = new WsCpuSampler(root, { connect: vi.fn(), post, disconnect: vi.fn() } as unknown as Session);
  sampler.start();
  await vi.advanceTimersByTimeAsync(15000);
  if (!overlapping) await vi.advanceTimersByTimeAsync(3000);
  const evidence = await sampler.capture(Date.now() - 1000);
  if (overlapping) expect(evidence.frames[0]).toMatchObject({ file: 'src/handler.ts', sampledMicros: 500000 });
  else expect(evidence.frames).toEqual([]);
  await sampler.stop();
});
it('keeps wedge and recovery detection working when CPU capture rejects', async () => {
  let now = 0;
  const capture = vi.fn(async () => { throw new Error('unavailable'); });
  const watchdog = new WsWatchdog({ nowMs: () => now, log: vi.fn(), scheduler: () => ({}), cancelScheduler: () => {},
    cpuSampler: { start: () => {}, stop: async () => {}, capture, getEvidence: () => ({ status: 'unavailable', frames: [] }) },
  });
  watchdog.start();
  for (let i = 0; i < 3; i++) { now += 1500; watchdog.tick(); await Promise.resolve(); await Promise.resolve(); }
  expect(watchdog.getStats()).toMatchObject({ wedged: true, wedgeCount: 1, cpuEvidence: { status: 'unavailable' } });
  now += 1000;
  watchdog.tick();
  expect(watchdog.getStats()).toMatchObject({ wedged: false, wedgeCount: 1 });
  watchdog.stop();
});
