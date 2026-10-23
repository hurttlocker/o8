import { readFile, writeFile } from 'node:fs/promises';
import { median, percentile } from './stats.mjs';

const runs = [];
const fixtureHash = '46471f2c5a78d461e9e11b4f30129a23f18aee84644b856cd2440373e85ae238';
for (const surface of ['native', 'web', 'terminal']) {
  for (let run = 1; run <= 3; run++) {
    const row = JSON.parse(await readFile(`results/isolated/${surface}-${run}.json`, 'utf8'));
    if (row.run !== run || row.surface !== surface || row.fixtureHash !== fixtureHash ||
      row.rows !== 2000 || row.width !== 1200 || row.height !== 816 || row.inputAcknowledged !== 20 ||
      row.tokens !== 80 || row.stream.length !== 80 || row.keys.length !== 20 || row.scroll.length !== 100 ||
      (surface === 'native' && row.processMs >= 9000) ||
      (surface === 'web' && row.observations.length !== 200) ||
      (surface === 'terminal' && (row.decodedFrames < 200 || row.keys.some((key, index) =>
        JSON.stringify(key.markerRGB) !== JSON.stringify(index % 2 ? [0, 255, 0] : [255, 0, 255]))))) throw Error(`Rejected ${surface}-${run}`);
    const q = (list, field) => Object.fromEntries([['p50', .5], ['p95', .95], ['p99', .99]].map(([key, value]) =>
      [key, percentile(list.map(sample => sample[field]), value)]));
    runs.push({ surface, run, inputAcknowledged: row.inputAcknowledged,
      keyToFrameMs: q(row.keys, 'elapsedMs'), streamUpdateMs: q(row.stream, surface === 'web' ? 'costMs' : 'elapsedMs'),
      scrollUpdateMs: q(row.scroll, surface === 'web' ? 'costMs' : 'elapsedMs'),
      streamDrawMs: surface === 'web' ? null : q(row.stream, 'drawMs'),
      scrollDrawMs: surface === 'web' ? null : q(row.scroll, 'drawMs'),
      tokensPerSecond: row.tokensPerSecond, nativeLifetimeMs: row.processMs ?? null });
  }
}
const summary = Object.fromEntries(['native', 'web', 'terminal'].map(surface => {
  const rows = runs.filter(row => row.surface === surface);
  const med = metric => rows[0][metric] === null ? null : Object.fromEntries(['p50', 'p95', 'p99'].map(key =>
    [key, median(rows.map(row => row[metric][key]))]));
  return [surface, { runs: 3, keysPerRun: 20, streamPerRun: 80, scrollPerRun: 100,
    keyToFrameMs: med('keyToFrameMs'), streamUpdateMs: med('streamUpdateMs'),
    scrollUpdateMs: med('scrollUpdateMs'), streamDrawMs: med('streamDrawMs'),
    scrollDrawMs: med('scrollDrawMs'), tokensPerSecond: median(rows.map(row => row.tokensPerSecond)) }];
}));
await writeFile('results/summary.json', JSON.stringify({ fixtureHash, runs, summary }, null, 2));
const fmt = value => ['p50', 'p95', 'p99'].map(key => value[key].toFixed(2)).join('/');
const table = [
  '| Arm / run | Key to internal frame ms p50/p95/p99 | Stream update cost ms p50/p95/p99 | Scroll update cost ms p50/p95/p99 | Tokens/s |',
  '| --- | --- | --- | --- | --- |',
  ...runs.map(row => `| ${row.surface} ${row.run} | ${fmt(row.keyToFrameMs)} | ${fmt(row.streamUpdateMs)} | ${fmt(row.scrollUpdateMs)} | ${row.tokensPerSecond.toFixed(2)} |`),
  ...Object.entries(summary).map(([surface, row]) => `| **${surface} median** | **${fmt(row.keyToFrameMs)}** | **${fmt(row.streamUpdateMs)}** | **${fmt(row.scrollUpdateMs)}** | **${row.tokensPerSecond.toFixed(2)}** |`),
].join('\n');
await writeFile('results/TABLE.md', table + '\n');
console.log(table);
