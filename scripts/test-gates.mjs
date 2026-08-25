#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const RETAIN_RECEIPT = '.o8-test-run-retain.json';
const heartbeatMs = Number(process.env.O8_TEST_GATE_HEARTBEAT_MS || 60_000);
let activeGateChild = null;
let activeGateMarker = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markerPids(marker) {
  if (process.platform === 'win32') return null;
  try {
    const result = runSync('ps', ['eww', '-axo', 'pid=,command=']);
    if (result.status !== 0) return null;
    const needle = `O8_TEST_GATE_MARKER=${marker}`;
    return result.stdout.split('\n').flatMap((line) => {
      if (!line.includes(needle)) return [];
      const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10);
      return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
    });
  } catch {
    return null;
  }
}

function runSync(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true,
  });
  return { status: result.status ?? 127, stdout: result.stdout ?? '' };
}

function gateGroupAlive(child) {
  if (!child?.pid || process.platform === 'win32') return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settleGateProcessTree(child, marker, firstSignal = 'SIGTERM') {
  if (!child?.pid) return false;
  for (const [signal, waitMs] of [
    [firstSignal, 500],
    ['SIGTERM', 750],
    ['SIGKILL', 1_000],
  ]) {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {}
    for (const pid of markerPids(marker) ?? []) {
      try { process.kill(pid, signal); } catch {}
    }
    await sleep(waitMs);
    const remaining = markerPids(marker);
    if (!gateGroupAlive(child) && remaining !== null && remaining.length === 0) return true;
  }
  const remaining = markerPids(marker);
  return !gateGroupAlive(child) && remaining !== null && remaining.length === 0;
}

function findRetainedFixtures(directory, results = []) {
  if (!existsSync(directory)) return results;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) findRetainedFixtures(absolute, results);
    else if (entry.isFile() && entry.name === RETAIN_RECEIPT) results.push(absolute);
  }
  return results;
}

function parseReport(reportPath) {
  if (!existsSync(reportPath)) return null;
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const failedFile = report.testResults?.find((result) => result.status === 'failed');
    const failedAssertion = failedFile?.assertionResults?.find((result) => result.status === 'failed');
    return {
      total: Number(report.numTotalTests ?? 0),
      passed: Number(report.numPassedTests ?? 0),
      failed: Number(report.numFailedTests ?? 0),
      pending: Number(report.numPendingTests ?? 0),
      firstFailure: failedAssertion?.fullName
        || failedAssertion?.title
        || failedFile?.name
        || null,
    };
  } catch {
    return null;
  }
}

async function runGate(gate, forwardedArgs) {
  const gateRoot = mkdtempSync(join(tmpdir(), `o8-test-gate-${gate.id}-`));
  const reportPath = join(gateRoot, 'vitest-report.json');
  const marker = `${gate.id}-${randomUUID().replace(/-/g, '')}`;
  const env = {
    ...process.env,
    CORTEX_IDE_DATA_DIR: gateRoot,
    O8_TEST_FIXTURE_SWEEP_PARENT: gateRoot,
    O8_TEST_GATE_MARKER: marker,
    O8_TEST_GATE_REPORT_PATH: reportPath,
  };
  delete env.O8_DATA_DIR;
  const startedAt = Date.now();
  console.log(`\n[test-gate] ${gate.label} started`);
  const commandArgs = gate.runner
    ? [gate.runner, ...forwardedArgs]
    : [vitest, 'run', '--config', gate.config, ...forwardedArgs];
  const child = spawn(process.execPath, commandArgs, {
    cwd: root,
    detached: process.platform !== 'win32',
    env,
    stdio: 'inherit',
  });
  activeGateChild = child;
  activeGateMarker = marker;
  const heartbeat = setInterval(() => {
    console.log(`[test-gate] ${gate.label} heartbeat (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  }, Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 60_000);
  heartbeat.unref();
  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal, error: null }));
  });
  clearInterval(heartbeat);
  const markerState = markerPids(marker);
  if (gateGroupAlive(child) || markerState === null || markerState.length > 0) {
    const treeSettled = await settleGateProcessTree(child, marker);
    if (!treeSettled) {
      outcome.code = 1;
      outcome.error = new Error('test gate process tree could not be confirmed stopped');
    }
  }
  if (activeGateChild === child) {
    activeGateChild = null;
    activeGateMarker = null;
  }
  const durationMs = Date.now() - startedAt;
  const report = parseReport(reportPath);
  const retained = findRetainedFixtures(gateRoot);
  if (retained.length === 0) {
    rmSync(gateRoot, { recursive: true, force: true });
  } else {
    console.error(`[test-gate] retained ${retained.length} timed-out fixture receipt${retained.length === 1 ? '' : 's'} under ${gateRoot}`);
  }
  return {
    id: gate.id,
    label: gate.label,
    code: outcome.code,
    signal: outcome.signal,
    error: outcome.error?.message ?? null,
    durationMs,
    retainedFixtures: retained,
    report,
  };
}

const defaultGates = [
  { id: 'unit', label: 'Hermetic unit gate', config: 'vitest.unit.config.ts' },
  { id: 'integration', label: 'Resource-owning integration gate', runner: 'scripts/integration-test-gate.mjs' },
];
const gates = process.env.O8_TEST_GATE_TEST_MODE === '1' && process.env.O8_TEST_GATE_PLAN
  ? JSON.parse(readFileSync(process.env.O8_TEST_GATE_PLAN, 'utf8'))
  : defaultGates;
const forwardedArgs = process.argv.slice(2);
let activeChildSignal = null;
const onSigint = () => {
  activeChildSignal = 'SIGINT';
  void settleGateProcessTree(activeGateChild, activeGateMarker ?? '', 'SIGINT');
};
const onSigterm = () => {
  activeChildSignal = 'SIGTERM';
  void settleGateProcessTree(activeGateChild, activeGateMarker ?? '', 'SIGTERM');
};
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

const results = [];
try {
  for (const gate of gates) {
    if (activeChildSignal) break;
    const result = await runGate(gate, forwardedArgs);
    results.push(result);
    if (result.code !== 0 || result.signal) break;
  }
} finally {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
}

console.log('\n[test-gate] summary');
for (const result of results) {
  const counts = result.report
    ? `${result.report.passed}/${result.report.total} passed, ${result.report.failed} failed`
    : 'test counts unavailable';
  console.log(`[test-gate] ${result.label}: ${result.code === 0 ? 'PASS' : 'FAIL'} · ${counts} · ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.report?.firstFailure) console.log(`[test-gate] first cause: ${result.report.firstFailure}`);
}
if (results.length < gates.length) {
  const nextGate = gates[results.length];
  if (nextGate) console.log(`[test-gate] ${nextGate.label}: NOT RUN (earlier gate failed or run was interrupted)`);
}

const failed = results.find((result) => result.code !== 0 || result.signal);
if (activeChildSignal) {
  console.error(`[test-gate] interrupted by ${activeChildSignal}; owned child group settlement was requested`);
  process.exit(130);
}
if (failed) {
  const classification = failed.id === 'unit'
    ? 'product_or_unit_harness_failure'
    : 'resource_or_integration_failure';
  console.error(`[test-gate] failure-class=${classification}`);
  process.exit(failed.code || 1);
}
process.exit(0);
