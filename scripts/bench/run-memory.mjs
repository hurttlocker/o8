// o8 benchmark-suite entrypoint; see tests/bench/README.md for usage.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { withServerOnlyStubNodeOptions } from '../run-lib.mjs';

const CATEGORIES = [
  'ownership',
  'decisions',
  'processes',
  'incidents',
  'specs',
  'cross-repo',
  'literal-lookup',
];

const LATEST_DIR = path.resolve(process.cwd(), 'tests/bench/latest');
const OUT_PATH = path.join(LATEST_DIR, 'memory.json');

function emptyPerCategory(note) {
  return Object.fromEntries(CATEGORIES.map((category) => [
    category,
    { full_accuracy: null, factualSum: null, scored: null, note },
  ]));
}

function emptyMemory(note) {
  return {
    generatedAt: new Date().toISOString(),
    note,
    summary: {
      overall: {
        full: null,
        grep: null,
        strongGrep: null,
        blind: null,
        delta_full_vs_strongGrep: null,
      },
      perCategory: emptyPerCategory(note),
    },
    sourceResults: null,
  };
}

function writeMemory(payload) {
  fs.mkdirSync(LATEST_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2));
}

function newestThreeWayResult() {
  const dir = path.resolve(process.cwd(), 'tests/qa-eval');
  let entries;
  try {
    entries = fs.readdirSync(dir)
      .filter((name) => /^three-way-results-.+\.json$/.test(name))
      .map((name) => {
        const absolute = path.join(dir, name);
        return { absolute, mtimeMs: fs.statSync(absolute).mtimeMs };
      });
  } catch {
    return null;
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0]?.absolute ?? null;
}

function resultPathFromStdout(stdout) {
  const match = stdout.match(/\[938\] wrote raw results to (.+\.json)/);
  return match ? match[1].trim() : null;
}

function projectMemory(raw, sourceResults) {
  const overall = raw?.summary?.overall ?? {};
  const rawCategories = raw?.summary?.perCategory ?? {};
  const perCategory = {};
  for (const category of CATEGORIES) {
    const full = rawCategories[category]?.full ?? {};
    const factualSum = typeof full.factualSum === 'number' ? full.factualSum : null;
    const scored = typeof full.scored === 'number' ? full.scored : null;
    const fullAccuracy = factualSum !== null && scored && scored > 0
      ? factualSum / scored
      : null;
    perCategory[category] = {
      full_accuracy: fullAccuracy,
      factualSum,
      scored,
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      overall: {
        full: typeof overall.full === 'number' ? overall.full : null,
        grep: typeof overall.grep === 'number' ? overall.grep : null,
        strongGrep: typeof overall.strongGrep === 'number' ? overall.strongGrep : null,
        blind: typeof overall.blind === 'number' ? overall.blind : null,
        delta_full_vs_strongGrep: typeof overall.delta_full_vs_strongGrep === 'number'
          ? overall.delta_full_vs_strongGrep
          : null,
      },
      perCategory,
    },
    sourceResults: path.resolve(sourceResults),
  };
}

function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    const note = 'OPENROUTER_API_KEY not set';
    console.error('*** BENCH MEMORY SKIPPED: OPENROUTER_API_KEY not set; not starting the three-way runner. ***');
    writeMemory(emptyMemory(note));
    return;
  }

  const result = spawnSync('npx', ['tsx', 'src/lib/cortex/qa/eval/three-way-runner.ts'], {
    stdio: ['inherit', 'pipe', 'inherit'],
    env: {
      ...process.env,
      O8_EVAL_MODE: '1',
      THREE_WAY_LIMIT: process.env.BENCH_QA_LIMIT ?? undefined,
      NODE_OPTIONS: withServerOnlyStubNodeOptions(),
    },
  });

  if (result.error || result.status !== 0) {
    const status = result.status ?? 'error';
    const note = `runner exit ${status}${result.error ? `: ${result.error.message}` : ''}`;
    writeMemory(emptyMemory(note));
    return;
  }

  const stdout = result.stdout ? result.stdout.toString('utf8') : '';
  const sourceResults = resultPathFromStdout(stdout) ?? newestThreeWayResult();
  if (!sourceResults) {
    writeMemory(emptyMemory('three-way results file not found'));
    return;
  }

  const raw = JSON.parse(fs.readFileSync(sourceResults, 'utf8'));
  writeMemory(projectMemory(raw, sourceResults));
}

try {
  main();
} catch (err) {
  const note = err instanceof Error ? err.message : String(err);
  try {
    writeMemory(emptyMemory(`run-memory failed: ${note}`));
  } catch {
    console.error(`run-memory failed: ${note}`);
  }
  process.exitCode = 0;
}
