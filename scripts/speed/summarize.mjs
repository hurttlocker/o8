#!/usr/bin/env node
// Private raw receipts in, path-free numeric summary out.
import fs from 'node:fs';
import path from 'node:path';
import { root, distribution, round } from './common.mjs';

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const read = name => {
  const file = path.resolve(option(name, `tmp/speed-evidence/${name}.json`));
  if (!fs.existsSync(file)) return null;
  if (!fs.realpathSync(file).startsWith(root + path.sep)) throw new Error('Receipts must stay in the worktree');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const stats = values => {
  const { samples: _samples, ...result } = distribution(values.filter(Number.isFinite));
  return result;
};
const processRss = groups => groups ? Object.fromEntries(Object.entries(groups).map(([name, rows]) => {
  const ids = new Set(rows.map(row => row.pid));
  const parent = rows.find(row => !ids.has(row.ppid));
  // Local discovery helpers are not part of the public machine inventory.
  const known = new Set(['o8', 'next-server', 'node', 'esbuild', 'codex', 'claude', 'git', 'ps', 'lsof', 'df', 'diskutil', 'sqlite3', 'tmux', 'bash', 'security']);
  return [name, rows.map(row => ({ process: known.has(row.process) ? row.process : 'helper', rssMiB: row.rssMiB,
    role: row.pid === parent?.pid ? 'root' : name === 'shell' && row.ppid === parent?.pid
      ? row.process === 'next-server' ? 'next-server' : row.process === 'node' ? 'ws-server' : 'descendant' : 'descendant' }))];
})) : null;
const ui = read('ui'), web = read('web'), native = read('native'), mcp = read('mcp');
const boot = read('boot'), nativeStartup = read('native-startup');
const codex = read('workers-codex'), claude = read('workers-claude-code');
const receipt = { schema: 'o8/speed-summary/v1', generatedAt: new Date().toISOString(), sourceHead: web?.sourceHead ?? null };
receipt.heapSnapshotMode = { web: web?.heapSnapshotMode ?? (web?.runs.some(row => row.heapBefore) ? 'paired' : 'after-only'),
  native: native?.heapSnapshotMode ?? (native?.samples.some(row => row.heapBefore) ? 'paired' : 'after-only') };
if (ui) {
  receipt.browser = { arms: {} };
  for (const sessions of [1, 4]) {
    const windows = ui.runs.flatMap(row => row.observations.filter(value => value.sessions === sessions));
    receipt.browser.arms[sessions] = { windows: windows.length,
      framesMs: stats(windows.flatMap(row => row.framesMs.samples)), keyMs: stats(windows.flatMap(row => row.keystrokeMs.samples)),
      taskMsPerSecond: stats(windows.map(row => row.taskMs / row.durationMs * 1000)),
      scriptMsPerSecond: stats(windows.map(row => row.scriptMs / row.durationMs * 1000)),
      layoutMsPerSecond: stats(windows.map(row => row.layoutMs / row.durationMs * 1000)),
      droppedFrames: windows.map(row => row.droppedFrames), subscribers: windows.map(row => row.subscribedSessions),
      censoredInputs: windows.reduce((sum, row) => sum + row.inputFailures.length, 0) };
  }
  receipt.browser.calibrationMs = ui.runs.map(row => row.calibrationMs);
}
if (mcp) receipt.mcp = (mcp.mcp ?? mcp).map(row => ({ name: row.name, firstCallMs: row.firstCallMs, bytes: row.bytes, ms: stats(row.ms.samples) }));
if (boot) receipt.browserStartup = {
  firstPaintMs: stats(boot.runs.map(row => row.boot.paints.find(paint => paint.name === 'first-paint')?.ms)),
  navigationToInteractiveMs: stats(boot.runs.map(row => row.boot.interactiveMs)),
  nextHealthyMs: stats(boot.runs.map(row => row.nextHealthyMs)), wsHealthyMs: stats(boot.runs.map(row => row.wsHealthyMs)),
};
if (nativeStartup) receipt.nativeStartup = Object.fromEntries(['loaderFirstContentfulPaintMs', 'firstPaintUpperBoundMs', 'interactiveMs', 'nextHealthyMs', 'wsHealthyMs', 'contextMs'].map(key => [key, stats(nativeStartup.samples.map(row => row[key]))]));
receipt.workers = {};
for (const [name, data] of [['codex', codex], ['claude-code', claude]]) {
  if (!data) continue;
  const samples = data.samples.filter(row => row.status === 'measured');
  receipt.workers[name] = { n: samples.length, model: samples[0]?.model, effort: samples[0]?.effort,
    limits: { fixture: 'Local Git origin; no dependency install requested. Real dependency clone is a separate calibration.',
      firstToken: name === 'codex' ? 'Unavailable; completed assistant message is an upper bound' : 'First observed token delta includes CLI and network startup' },
    dispatchToAssistantOutputMs: stats(samples.map(row => row.dispatchToAssistantOutputMs)),
    dispatchToFirstByteMs: stats(samples.map(row => row.dispatchToFirstByteMs)),
    dispatchToRecordedSpawnMs: stats(samples.map(row => row.dispatchToRecordedSpawnMs)),
    spawnToAssistantOutputMs: stats(samples.map(row => row.spawnToAssistantOutputMs)),
    modelFirstTokenMs: stats(samples.map(row => row.modelFirstTokenMs).filter(Number.isFinite)),
    stages: Object.fromEntries(['admissionMs', 'workspaceProvisioningMs', 'runtimeSpawnMs', 'dependencyProvisioningMs'].map(key => [key, stats(samples.filter(row => key !== 'dependencyProvisioningMs' || row.stages?.timings?.some(timing => timing.stage === 'dependency_materialization')).map(row => row.stages?.[key]))])),
    preparation: Object.fromEntries(['clone', 'checkout', 'asset_hydration'].map(key => [key, stats(samples.flatMap(row => row.stages?.timings?.filter(timing => timing.stage === key).map(timing => timing.durationMs) ?? []))])),
    processesBeforeOutput: samples.map(row => {
      const end = row.dispatchAt + row.dispatchToAssistantOutputMs;
      return row.processSpans.filter(span => span.event === 'start' && span.at <= end).reduce((counts, span) => {
        counts[span.command] = (counts[span.command] ?? 0) + 1; return counts;
      }, {});
    }),
  };
}
if (web) receipt.webMemory = web.runs.map(row => ({ sample: row.index,
  bootRss: processRss(row.bootRss), workloadBootRss: processRss(row.beforeSoakRss), hourRss: processRss(row.hourRss),
  beforeSoakPostGc: row.beforeSoakPostGc, hourPostGc: row.hourPostGc,
  heapBefore: row.heapBefore, heapAfter: row.heapAfter,
  completed: row.soak?.completed, durationMs: row.soak?.actualMs,
}));
if (native) receipt.nativeMemory = { complete: native.complete, failureCount: native.failures.length,
  samples: native.samples.map(row => ({ sample: row.sample, workload: row.workload,
    actualSoakMs: row.actualSoakMs, beforePostGc: row.beforePostGc, afterPostGc: row.afterPostGc,
    bootRss: processRss(row.bootRss), workloadBootRss: processRss(row.workloadBootRss), hourRss: processRss(row.hourRss),
    heapBefore: row.heapBefore, heapAfter: row.heapAfter, renderedMessages: row.renderedMessages, feedErrors: row.feedErrors?.length ?? 0 })) };
const clone = read('dependency-clone'), guard = read('guard-cost');
if (clone) receipt.dependencyCloneMs = clone.ms;
if (guard) receipt.guardCostMs = { direct: stats(guard.directMs.samples), guarded: stats(guard.guardedMs.samples), medianOverhead: round(guard.guardedMs.median - guard.directMs.median) };
for (const name of ['codex', 'claude-code']) {
  const data = read(`workers-${name}-full`);
  if (data && receipt.workers[name]) receipt.workers[name].separateFullWorkflow = Object.fromEntries(['missionPreparationMs', 'requestToAssistantOutputMs', 'dispatchToAssistantOutputMs'].map(key => [key, stats(data.samples.filter(row => row.status === 'measured').map(row => row[key]))]));
}
const owners = read('allocation-owners'), snapshotCost = read('snapshot-cost');
if (owners) receipt.nativeAllocationOwners = owners;
if (snapshotCost) receipt.snapshotControl = { samples: snapshotCost.samples, snapshotAddedRssMiB: snapshotCost.snapshotAddedRssMiB, limits: snapshotCost.limits };
const installed = read('installed-memory');
if (installed) receipt.installedReadOnlyObservation = installed;
// Keep numeric rows together so the committed receipt stays easy to compare.
function format(value, depth = 0) {
  const flat = JSON.stringify(value);
  if (flat === undefined) return 'null';
  if (flat.length <= 160 || value === null || typeof value !== 'object') return flat;
  const pad = '  '.repeat(depth + 1), end = '  '.repeat(depth);
  const array = Array.isArray(value);
  const rows = array ? value.map(row => pad + format(row, depth + 1))
    : Object.entries(value).filter(([, row]) => row !== undefined).map(([key, row]) => `${pad}${JSON.stringify(key)}: ${format(row, depth + 1)}`);
  return `${array ? '[' : '{'}\n${rows.join(',\n')}\n${end}${array ? ']' : '}'}`;
}
process.stdout.write(format(receipt) + '\n');
