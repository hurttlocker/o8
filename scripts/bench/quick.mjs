#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const EPHEMERAL = process.argv.includes('--ephemeral');

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'could not resolve git SHA');
  return result.stdout.trim();
}

function runNode(scriptPath, env) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 115_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(scriptPath)} exited ${result.status ?? 'with an error'}: ${result.error?.message ?? result.stderr.trim()}`);
  }
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
      tracks: { speed: scorecard.tracks.speed },
    };
    let resultPath = null;
    if (!EPHEMERAL) {
      fs.mkdirSync(resultsDir, { recursive: true });
      resultPath = path.join(resultsDir, `${version}.json`);
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
      console.log(`[bench-quick] wrote ${resultPath}`);
    }

    const receipt = {
      schema: 'o8/benchmark-quick-preflight/v1',
      ...summary,
      durationMs: result.durationMs,
      version,
      gitSha: sha,
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
