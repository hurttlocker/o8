// Configuration and machine-readable receipt plumbing. Measurement code stays
// separate so target identity and baseline admission can be tested without
// launching a browser or server stack.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QUICK_FIXTURE_SCALES, DEFAULT_FIXTURE_SEED } from './fixtures.mjs';
import { parseTargetOption, packagedTargetIdentityProblems } from './targets.mjs';
import { snapshotProcessInventory } from './cleanup.mjs';

function option(argv, name, fallback) {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function numericOption(argv, name, fallback) {
  const parsed = Number(option(argv, name, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function interactionConfig(root, argv = process.argv.slice(2)) {
  const scales = String(option(argv, 'scales', QUICK_FIXTURE_SCALES.join(',')))
    .split(',').map(Number).filter((value) => Number.isInteger(value) && value > 0);
  const archiveSha256 = option(argv, 'archive-sha256', null);
  const releaseGitSha = option(argv, 'release-git-sha', null);
  if (archiveSha256 !== null && !/^[0-9a-f]{64}$/i.test(archiveSha256)) {
    throw new Error('--archive-sha256 must be a 64-character hexadecimal SHA-256');
  }
  if (releaseGitSha !== null && !/^[0-9a-f]{40}$/i.test(releaseGitSha)) {
    throw new Error('--release-git-sha must be a full 40-character hexadecimal commit SHA');
  }
  const target = parseTargetOption(option(argv, 'target', 'source'));
  if (target.kind === 'release' && releaseGitSha === null) {
    throw new Error('--release-git-sha is required for release targets');
  }
  return {
    scales: scales.length > 0 ? scales : [...QUICK_FIXTURE_SCALES],
    seed: numericOption(argv, 'seed', DEFAULT_FIXTURE_SEED) || DEFAULT_FIXTURE_SEED,
    samples: Math.max(1, numericOption(argv, 'samples', 7)),
    soakMs: Math.max(0, numericOption(argv, 'soak-ms', 12_000)),
    injectedDelayMs: Math.max(0, numericOption(argv, 'inject-delay-ms', 500)),
    bootTimeoutMs: Math.max(10_000, numericOption(argv, 'boot-timeout-ms', 120_000)),
    composerTimeoutMs: Math.max(10_000, numericOption(argv, 'composer-timeout-ms', 120_000)),
    revealTimeoutMs: Math.max(5_000, numericOption(argv, 'reveal-timeout-ms', 60_000)),
    inventoryTimeoutMs: Math.max(3_000, numericOption(argv, 'inventory-timeout-ms', 10_000)),
    requestedBuildMode: String(option(argv, 'build-mode', 'auto')),
    target,
    archiveSha256: archiveSha256?.toLowerCase() ?? null,
    releaseGitSha: releaseGitSha?.toLowerCase() ?? null,
    outputPath: path.resolve(option(argv, 'output', path.join(root, 'tests/bench/latest/interactions.json'))),
    baselinePath: path.resolve(option(argv, 'baseline', path.join(root, 'tests/bench/results/interactions-baseline.json'))),
    composeTerminalWorkload: !argv.includes('--no-compose'),
    writeBaseline: argv.includes('--write-baseline'),
    reportOnly: argv.includes('--report-only'),
  };
}

export function benchmarkIdentity(root) {
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? null; } catch { version = null; }
  let gitSha = null;
  try { gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() || null; } catch { gitSha = null; }
  return { version, gitSha };
}

export function hostProfile() {
  return {
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? null,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
    osRelease: os.release(),
  };
}

export function contentionSnapshot() {
  let processes = null;
  try { processes = snapshotProcessInventory(); } catch { processes = new Map(); }
  const commands = [...processes.values()].map((entry) => entry.command);
  return {
    capturedAt: new Date().toISOString(),
    loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
    logicalCpuCount: os.cpus().length,
    systemUptimeSeconds: Math.round(os.uptime()),
    processCount: processes.size,
    nodeProcessCount: commands.filter((command) => /(?:^|\/)node\b|next-server/.test(command)).length,
    vitestProcessCount: commands.filter((command) => command.includes('vitest')).length,
    nextServerProcessCount: commands.filter((command) => command.includes('next-server')).length,
    websocketServerProcessCount: commands.filter((command) => command.includes('ws-server')).length,
    note: 'observational contention context only; the harness does not stop foreign processes',
  };
}

export function readBaseline(root, baselinePath) {
  try {
    const data = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    return { ...data, source: path.relative(root, baselinePath).split(path.sep).join('/') };
  } catch {
    return null;
  }
}

export function baselineWriteProblems(receipt) {
  const problems = [];
  if (receipt?.targetLane?.kind !== 'release') problems.push('baseline writes require --target=release:<path>');
  if (!Array.isArray(receipt?.runs) || receipt.runs.length === 0) problems.push('receipt has no measured runs');
  for (const run of receipt?.runs ?? []) {
    for (const problem of packagedTargetIdentityProblems(run.target, run.stack)) {
      problems.push(`scale ${run.scale}: ${problem}`);
    }
    if (run.cleanup?.status !== 'clean') problems.push(`scale ${run.scale}: cleanup was not clean`);
    if (
      run.falsification?.delayExecuted !== true
      || !Number.isInteger(run.falsification?.injectedDelayApplications)
      || run.falsification.injectedDelayApplications < 1
    ) {
      problems.push(`scale ${run.scale}: falsification has no injected-delay execution proof`);
    }
    if (run.falsification?.budgetFailed !== true) problems.push(`scale ${run.scale}: falsification did not fail the budget`);
  }
  if (receipt?.runStatus === 'invalid' || receipt?.runStatus === 'unavailable') {
    problems.push(`receipt status ${receipt.runStatus} is not baseline-writable`);
  }
  return [...new Set(problems)];
}

export function baselineFromReceipt(receipt) {
  const problems = baselineWriteProblems(receipt);
  if (problems.length > 0) throw new Error(`refusing baseline write: ${problems.join('; ')}`);
  const metrics = {};
  for (const run of receipt.runs ?? []) {
    for (const result of run.budgets?.results ?? []) {
      if (!Number.isFinite(result.value)) continue;
      metrics[`${result.metric}@${run.scale}`] = {
        value: result.value,
        statistic: result.statistic,
        scale: run.scale,
      };
    }
  }
  const firstRun = receipt.runs[0];
  return {
    schema: 'o8/interaction-baseline/v1',
    status: 'observed',
    observedAt: new Date().toISOString(),
    observedFrom: {
      benchmarkVersion: receipt.version ?? null,
      benchmarkGitSha: receipt.gitSha ?? null,
      measuredTarget: firstRun.target,
      packagedArtifact: firstRun.stack.releaseArtifact,
      targetLane: receipt.targetLane,
      fixtureDigests: receipt.runs.map((run) => ({ scale: run.scale, digest: run.fixture?.digest ?? null })),
      host: receipt.host ?? null,
      contention: receipt.contention ?? null,
      samples: receipt.samples ?? null,
      runStatus: receipt.runStatus,
    },
    metrics,
  };
}

export function writeReceipt(outputPath, receipt) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

export function deriveRunStatus(runs, extraValidity = []) {
  const validity = [
    ...runs.flatMap((run) => (run.validity ?? []).map((problem) => `scale ${run.scale}: ${problem}`)),
    ...extraValidity,
  ];
  const anyValue = runs.some((run) => (run.budgets?.results ?? []).some((result) => Number.isFinite(result.value)));
  const runStatus = !anyValue
    ? 'unavailable'
    : validity.length > 0
      ? 'invalid'
      : runs.some((run) => run.budgets?.status === 'fail')
        ? 'fail'
        : runs.some((run) => run.budgets?.status === 'incomplete')
          ? 'incomplete'
          : 'pass';
  return { runStatus, validity };
}

export function printSummary(receipt) {
  console.log('[bench:interactions] scale\tmetric\tstatistic\tvalue\tbudget\tstatus\tdelta');
  for (const run of receipt.runs) {
    for (const result of run.budgets?.results ?? []) {
      console.log([
        '[bench:interactions]', run.scale, result.metric, result.statistic,
        result.value ?? 'null', result.budgetMax,
        result.status === 'unavailable' ? `unavailable (${result.reason})` : result.status,
        result.deltaStatus === 'no-baseline' ? 'no-baseline' : `${result.deltaValue ?? 'null'} ${result.deltaStatus}`,
      ].join('\t'));
    }
  }
}
