#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { distribution, evidencePath, root, round, rss, sleep, writeJson } from './common.mjs';
import { fixture, startStack } from './stack.mjs';
import { openBrowser } from './ui.mjs';
import { measureMcp, tool } from './mcp.mjs';
import { inspector, postGc, summarizeHeap } from './memory.mjs';
import { measureWorker, prepareWorkerFixture } from './workers.mjs';

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const runs = Number(option('runs', '3'));
const soakMs = Number(option('soak-ms', '3600000'));
const mode = option('build-mode', 'production');
const workers = process.argv.includes('--workers');
const noMcp = process.argv.includes('--no-mcp');
const pairedHeaps = process.argv.includes('--paired-heaps');
if (!Number.isInteger(runs) || runs < 3 || runs > 10 || !Number.isInteger(soakMs) || soakMs < 0 || !['production', 'next-dev'].includes(mode)) throw new Error('Use 3-10 runs, nonnegative integer soak-ms, and production or next-dev build-mode.');
const output = evidencePath(option('output', 'tmp/speed-evidence/baseline.json'));
const evidence = path.join(path.dirname(output), `run-${Date.now()}`);
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const receipt = { schema: 'o8/speed-baseline/v1', generatedAt: new Date().toISOString(),
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  host: { platform: os.platform(), architecture: os.arch(), logicalCpus: os.cpus().length, cpu: os.cpus()[0]?.model, ramGiB: os.totalmem() / 1024 ** 3, node: process.version },
  buildMode: mode, heapSnapshotMode: pairedHeaps ? 'paired' : 'after-only', runs: [], workers: [], failures: [],
  workload: { transcriptEntriesPerSession: 300, sessions: 4, stressCadenceMs: 50, soakCadenceMs: 1000, soakMs,
    note: 'Synthetic provider snapshots, real dashboard and render path. Real local HTTP MCP. Source build, not installed-release timing. Concurrent soaks have contention.' },
};
const log = text => process.stderr.write(`[speed] ${text}\n`);
const checkpoint = () => writeJson(output, receipt);
const live = [];
let stopping = false;
const cleanup = async () => {
  if (stopping) return;
  stopping = true;
  for (const owned of live) {
    owned.inspect?.close(); owned.wsInspect?.close();
    await owned.ui?.close().catch(() => {});
    await owned.stack?.close().catch(() => {});
  }
};
process.once('SIGINT', () => { void cleanup().then(() => process.exit(130)); });
process.once('SIGTERM', () => { void cleanup().then(() => process.exit(143)); });

async function prepare(index) {
  const runEvidence = path.join(evidence, `sample-${index}`);
  fs.mkdirSync(runEvidence, { recursive: true, mode: 0o700 });
  const seeded = fixture(runEvidence);
  if (workers && index === 1) prepareWorkerFixture(seeded);
  const owned = { seeded, evidence: runEvidence };
  live.push(owned);
  log(`sample ${index}: isolated servers starting`);
  owned.stack = await startStack(seeded, runEvidence, mode);
  const stack = owned.stack;
  const row = { index, loadAverage: os.loadavg(), serverBootMs: { nextHealthy: stack.nextHealthyMs, wsHealthy: stack.wsHealthyMs },
    bootRss: rss({ next: stack.next.child.pid, ws: stack.ws.child.pid }), ui: [] };
  receipt.runs.push(row);
  owned.row = row;
  owned.inspect = await inspector(stack.next);
  owned.wsInspect = await inspector(stack.ws);
  row.bootMemory = { next: await owned.inspect.usage(), ws: await owned.wsInspect.usage() };
  owned.ui = await openBrowser(stack, seeded);
  row.browserBoot = owned.ui.boot;
  checkpoint();
  await tool(stack, 'create_mission', { repoPath: seeded.repoDir, runtime: 'codex', model: 'gpt-6.1-sol', requestedEffort: 'medium', dispatch: false, holdMerges: true,
    issues_inline: [{ title: 'Speed read fixture', body: 'Read-only fixture for status and task-list latency. Do not dispatch.' }] });
  if (index === 1) {
    if (!noMcp) {
      log('Measuring ten MCP operations, 30 interleaved samples each');
      try { receipt.mcp = await measureMcp(stack, seeded.repoDir); } catch (error) { receipt.failures.push({ phase: 'mcp', error: error.message }); }
    }
    if (workers) for (const runtime of ['codex', 'claude-code']) for (let sample = 1; sample <= 3; sample++) {
      log(`worker ${runtime} ${sample}/3`);
      try { receipt.workers.push(await measureWorker(stack, seeded, runEvidence, runtime, sample)); }
      catch (error) { receipt.failures.push({ phase: 'worker', runtime, sample, error: error.message }); }
      checkpoint();
    }
  }
  // Both arms keep four tabs mounted. Only the delivered session count changes.
  for (let sample = 1; sample <= 3; sample++) for (const sessions of sample % 2 ? [1, 4] : [4, 1]) {
    log(`sample ${index}: UI repetition ${sample}, ${sessions} streaming sessions`);
    row.ui.push({ sample, ...await owned.ui.measure(sessions) });
    checkpoint();
  }
  // Negative control uses the same product keydown path and paint observer.
  await owned.ui.page.evaluate(() => {
    window.__speedDelay = () => { const start = performance.now(); while (performance.now() - start < 150) { /* intentional calibration stall */ } };
    document.querySelector('textarea[data-o8-active-composer="true"]').addEventListener('keydown', window.__speedDelay, true);
  });
  row.calibration = { injectedMs: 150, observedMs: await owned.ui.key() };
  await owned.ui.page.evaluate(() => document.querySelector('textarea[data-o8-active-composer="true"]').removeEventListener('keydown', window.__speedDelay, true));
  if (row.calibration.observedMs < 150) throw new Error('Keystroke calibration did not detect injected delay');
  row.beforeSoakRss = rss({ next: stack.next.child.pid, ws: stack.ws.child.pid });
  row.beforeSoakPostGc = { next: await postGc(owned.inspect), ws: await postGc(owned.wsInspect) };
  if (pairedHeaps) {
    await owned.inspect.snapshot(path.join(runEvidence, 'next-before.heapsnapshot'));
    row.heapBefore = summarizeHeap(path.join(runEvidence, 'next-before.heapsnapshot'));
  }
  checkpoint();
  return owned;
}

async function soak(owned) {
  const { stack, row, ui } = owned;
  ui.setSessions(4);
  const started = performance.now();
  row.soak = { startedAt: new Date().toISOString(), samples: [], completed: false, errors: [] };
  let ticks = 0;
  const feed = setInterval(() => ui.advance(), 1000);
  try {
    while (performance.now() - started < soakMs) {
      const wait = Math.min(15000, soakMs - (performance.now() - started));
      if (wait > 0) await sleep(wait);
      ticks++;
      try { await tool(stack, ticks % 2 ? 'o8_task_list' : 'get_mission_status'); }
      catch (error) { row.soak.errors.push({ elapsedMs: round(performance.now() - started), error: error.message }); }
      await ui.composer.fill(`Unsent soak draft ${ticks % 10}`);
      if (ticks % 4 === 0) {
        const sample = { elapsedMs: round(performance.now() - started), rss: rss({ next: stack.next.child.pid, ws: stack.ws.child.pid }), next: await owned.inspect.usage(), ws: await owned.wsInspect.usage() };
        row.soak.samples.push(sample);
        log(`sample ${row.index}: soak ${Math.floor(sample.elapsedMs / 60000)} min`);
        checkpoint();
      }
    }
  } finally { clearInterval(feed); }
  row.soak.actualMs = round(performance.now() - started);
  row.soak.completed = row.soak.actualMs >= soakMs;
  row.hourRss = rss({ next: stack.next.child.pid, ws: stack.ws.child.pid });
  row.hourMemory = { next: await owned.inspect.usage(), ws: await owned.wsInspect.usage() };
  row.hourPostGc = { next: await postGc(owned.inspect), ws: await postGc(owned.wsInspect) };
  await owned.inspect.snapshot(path.join(owned.evidence, 'next-after.heapsnapshot'));
  row.heapAfter = summarizeHeap(path.join(owned.evidence, 'next-after.heapsnapshot'));
  row.browserErrors = ui.errors;
  checkpoint();
}
try {
  const soaks = [];
  for (let index = 1; index <= runs; index++) {
    const owned = await prepare(index);
    soaks.push(soak(owned));
  }
  await Promise.all(soaks);
  receipt.summary = {
    nextHealthyMs: distribution(receipt.runs.map(run => run.serverBootMs.nextHealthy)),
    wsHealthyMs: distribution(receipt.runs.map(run => run.serverBootMs.wsHealthy)),
    browserInteractiveMs: distribution(receipt.runs.map(run => run.browserBoot.interactiveMs)),
  };
} catch (error) { receipt.failures.push({ phase: 'run', error: error.stack ?? error.message }); }
finally { await cleanup(); }
receipt.complete = receipt.failures.length === 0 && receipt.runs.length >= 3 && receipt.runs.every(run => run.soak?.completed && !run.soak.errors.length && run.ui.every(window => !window.inputFailures.length)) && soakMs >= 3600000;
checkpoint();
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
if (receipt.failures.length) process.exitCode = 1;
