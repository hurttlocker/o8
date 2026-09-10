import { expect, it } from 'vitest';
// @ts-expect-error -- benchmark modules are intentionally native JavaScript.
import { measureProcessGroups, snapshotProcessCounters } from '../scripts/bench/terminal-workload/runtime.mjs';

it('pairs CPU counters with their own snapshot interval after memory probing', () => {
  let time = 12_000; // The completed memory probe is outside the CPU window.
  const read = (cpuTimeSeconds: number) => snapshotProcessCounters(() => {
    time += 20;
    return new Map([[7, { pid: 7, ppid: 1, command: 'fixture', cpuTimeSeconds }]]);
  }, () => time);
  const before = read(3);
  time += 10_000;
  const after = read(5);
  const elapsed = after.sampledAtMs - before.sampledAtMs;
  expect(before.sampledAtMs).toBe(12_010);
  expect(after.sampledAtMs).toBe(22_030);
  expect(elapsed).toBe(10_020);
  const measured = measureProcessGroups(before.processes, after.processes, { renderer: [7] }, elapsed);
  expect(measured.renderer.cpuPercent).toBe(19.96);
});
