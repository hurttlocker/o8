#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const EPHEMERAL = process.argv.includes('--ephemeral');

function readJsonOptional(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'could not resolve git SHA');
  return result.stdout.trim();
}

function runNode(scriptPath, env, { args = [], timeout = 115_000, tolerateFailure = false } = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    const failure = `${path.basename(scriptPath)} exited ${result.status ?? 'with an error'}: ${result.error?.message ?? result.stderr.trim()}`;
    if (!tolerateFailure) throw new Error(failure);
    return { ok: false, failure };
  }
  return { ok: true, failure: null };
}

export function summarizeInteractionReceipt(receipt, failure = null) {
  if (!receipt) {
    return {
      status: 'unavailable',
      reason: failure ?? 'interactions.json was not written',
      failed: [],
      regressed: [],
      unavailable: [],
      validity: [],
    };
  }
  const runs = receipt.runs ?? [];
  // A receipt that exists speaks for itself. `failure` only explains a MISSING
  // receipt; reusing it here would relabel an honest budget failure as a
  // harness crash.
  return {
    status: receipt.runStatus ?? 'unavailable',
    reason: receipt.unavailableReason ?? null,
    budgetManifest: receipt.budgetManifest ?? null,
    failed: runs.flatMap((run) => (run.budgets?.failed ?? []).map((metric) => ({ scale: run.scale, metric }))),
    regressed: runs.flatMap((run) => (run.budgets?.regressed ?? []).map((metric) => ({ scale: run.scale, metric }))),
    unavailable: runs.flatMap((run) => (run.budgets?.unavailable ?? []).map((entry) => ({ scale: run.scale, ...entry }))),
    validity: receipt.validity ?? [],
    targetLane: receipt.targetLane?.kind ?? null,
    composedTerminalWorkload: {
      status: receipt.composed?.terminalWorkload?.status ?? 'unavailable',
      reason: receipt.composed?.terminalWorkload?.unavailableReason ?? null,
    },
    falsification: runs.map((run) => ({
      scale: run.scale,
      injectedDelayMs: run.falsification?.injectedDelayMs ?? null,
      injectedDelayApplications: run.falsification?.injectedDelayApplications ?? null,
      delayExecuted: run.falsification?.delayExecuted ?? false,
      budgetFailed: run.falsification?.budgetFailed ?? false,
      skippedReason: run.falsification?.skippedReason ?? null,
    })),
    cleanup: runs.map((run) => ({ scale: run.scale, status: run.cleanup?.status ?? 'unknown' })),
  };
}

export function summarizeQuickScorecard(card) {
  const metrics = card?.tracks?.speed?.metrics ?? {};
  const regressions = [];
  const missing = [];
  for (const [name, metric] of Object.entries(metrics)) {
    if (metric?.delta === 'regressed') {
      regressions.push({ name, deltaValue: metric.deltaValue ?? null });
    }
    if (metric?.delta === 'missing' || typeof metric?.value !== 'number') missing.push(name);
  }
  return {
    status: regressions.length > 0 ? 'regressed' : missing.length > 0 ? 'incomplete' : 'ok',
    regressions,
    missing,
  };
}

function main() {
  const startedAt = Date.now();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-bench-quick-'));
  try {
    const latestDir = path.join(tempRoot, 'latest');
    const scorecardDir = path.join(tempRoot, 'scorecards');
    const resultsDir = path.resolve(process.env.O8_BENCH_RESULTS_DIR || path.join(ROOT, 'tests/bench/results'));
    const priorDirs = [resultsDir, path.join(ROOT, 'tests/bench/scorecards')];
    const env = {
      ...process.env,
      N: process.env.O8_BENCH_QUICK_SAMPLES || '5',
      BOOTSTRAP_SETTLE_SECONDS: process.env.O8_BENCH_QUICK_SETTLE_SECONDS || '1',
      O8_BENCH_BOOT_TIMEOUT_MS: process.env.O8_BENCH_QUICK_BOOT_TIMEOUT_MS || '20000',
      O8_BENCH_SOCKET_DURATION_SECONDS: process.env.O8_BENCH_QUICK_SOCKET_SECONDS || '5',
      O8_BENCH_LATEST_DIR: latestDir,
      O8_BENCH_SCORECARD_DIR: scorecardDir,
      O8_BENCH_PRIOR_SCORECARD_DIRS: priorDirs.join(path.delimiter),
    };
    runNode(path.join(ROOT, 'scripts/bench/run-speed.mjs'), env);

    // The interaction lane generates its own deterministic scale fixtures,
    // boots an isolated stack against them, and cleans up after itself. It is
    // slower than the service-speed lane, so it gets its own bound and a
    // tolerated failure: a broken interaction lane must be reported, not
    // allowed to erase the speed measurement that already succeeded.
    const interactionsPath = path.join(latestDir, 'interactions.json');
    const interactionsRun = runNode(path.join(ROOT, 'scripts/bench/run-interactions.mjs'), env, {
      args: [
        `--output=${interactionsPath}`,
        `--scales=${process.env.O8_BENCH_QUICK_INTERACTION_SCALES || '50'}`,
        `--samples=${process.env.O8_BENCH_QUICK_INTERACTION_SAMPLES || '7'}`,
        `--soak-ms=${process.env.O8_BENCH_QUICK_INTERACTION_SOAK_MS || '10000'}`,
      ],
      timeout: Number(process.env.O8_BENCH_QUICK_INTERACTION_TIMEOUT_MS || 420_000),
      tolerateFailure: true,
    });
    const interactions = readJsonOptional(interactionsPath);

    runNode(path.join(ROOT, 'scripts/bench/score.mjs'), env);

    const version = packageVersion();
    const sha = gitSha();
    const scorecardPath = path.join(scorecardDir, `scorecard-${version}-${sha}.json`);
    const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
    const summary = summarizeQuickScorecard(scorecard);
    const result = {
      schema: 'o8/benchmark-quick/v1',
      version,
      gitSha: sha,
      timestamp: scorecard.timestamp,
      durationMs: Date.now() - startedAt,
      comparedTo: scorecard.comparedTo ?? null,
      target: scorecard.target ?? null,
      tracks: {
        speed: scorecard.tracks.speed,
        interactions: interactions ?? { status: 'unavailable', reason: interactionsRun.failure ?? 'interactions.json was not written' },
      },
    };
    let resultPath = null;
    if (!EPHEMERAL) {
      fs.mkdirSync(resultsDir, { recursive: true });
      resultPath = path.join(resultsDir, `${version}.json`);
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
      console.log(`[bench-quick] wrote ${resultPath}`);
    }

    const interactionSummary = summarizeInteractionReceipt(interactions, interactionsRun.failure);
    const receipt = {
      schema: 'o8/benchmark-quick-preflight/v1',
      ...summary,
      interactions: interactionSummary,
      durationMs: result.durationMs,
      version,
      gitSha: sha,
      target: result.target,
      comparedTo: result.comparedTo,
      resultPath: resultPath ? path.relative(ROOT, resultPath).split(path.sep).join('/') : null,
    };
    console.log(`O8_BENCH_QUICK_RECEIPT=${JSON.stringify(receipt)}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[bench-quick] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
