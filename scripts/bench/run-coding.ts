/**
 * Coding-track runner — head-to-head first-diff quality, automated.
 *
 * Two phases, runnable separately because the first is slow and expensive:
 *
 *   --collect   build one worktree per (task x condition), run the arm, save the diff
 *   --judge     blind the saved diffs, judge each task, write tests/bench/latest/coding.json
 *
 * With no flag it runs both.
 *
 * WHY THE JUDGE IS A CLI PROCESS: the 2026-08-02 run tried six in-process judge
 * agents and every one completed its analysis and then failed to return it. A
 * judge that writes a JSON file to disk either produced a verdict or did not —
 * there is no silent-loss mode. Do not replace this with an in-process agent.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CODING_CONDITIONS,
  type CodingCondition,
  type CodingTask,
  type CodingVerdict,
  blindCodingDiffs,
  meanSubScores,
  scoreCodingResults,
  scrubAuthorship,
} from './coding';

const REPO_ROOT = process.cwd();
const TASKS_FILE = path.join(REPO_ROOT, 'tests/bench/coding/tasks.json');
const WORK_ROOT = path.join(os.tmpdir(), 'o8-bench-coding');
const LATEST_DIR = path.join(REPO_ROOT, 'tests/bench/latest');

const RAW_BRIEF = `You are implementing a real GitHub issue in this repository, which is a clean
checkout at the commit where the issue was still open.

Produce the best first diff you can — correct, minimal, and fit for this codebase.
Conventions are in CLAUDE.md and AGENTS.md at the repo root and are binding.
Implement the issue fully without expanding scope beyond what it asks.
Verify with \`npx tsc --noEmit\` (must exit 0) and \`npx eslint\` on files you changed.
Leave your work UNCOMMITTED. Do not commit, push, or create branches.
Do not modify tests to make something pass.`;

const GOVERNED_EXTRA = `
You are a dispatched o8 worker executing a packet.
Files follow an 800-line maximum; extract focused modules rather than exceeding it.
Cross-process seams, persistence paths, and authorization changes must be exercised
through the REAL production entry point — a helper-only test does not prove callers
can reach the behavior.
Self-review gate: review your own diff against the task, fix anything that would
BREAK it (typecheck failure, runtime crash, scope creep, security risk), capping fix
attempts at two per issue, then report.`;

const REVIEW_TRACE = `Adversarially review your own diff before calling it done. Run \`git diff\` and produce
four explicit traces, citing specific lines — "looks correct" without a citation is not
an answer.
1. GUARD/PREDICATE — for every condition added or changed, what makes it true, what
   makes it false, and is the true branch reachable from a real caller?
2. SCOPE/PARTITION — enumerate the cases the task covers and show which line handles
   each. Name any case that falls through to nothing.
3. SUB-REQUIREMENT COVERAGE — list every requirement in the issue and cite the line
   satisfying it. Mark any you did not implement.
4. EXECUTION-PATH — follow one real invocation from entry point to effect and confirm
   the new code is on that path.
Fix what the traces expose, cap fixes at two per finding, re-run \`npx tsc --noEmit\`,
and leave work UNCOMMITTED.`;

function readTasks(): CodingTask[] {
  const parsed = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8')) as { tasks: CodingTask[] };
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('tests/bench/coding/tasks.json has no tasks');
  }
  return parsed.tasks;
}

function issueText(issue: number): string {
  try {
    return execFileSync(
      'gh',
      ['issue', 'view', String(issue), '-R', 'hurttlocker/o8', '--json', 'title,body',
        '--jq', '"# " + .title + "\\n\\n" + .body'],
      { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 },
    ).trim();
  } catch {
    throw new Error(`could not read issue #${issue} via gh — is gh authenticated?`);
  }
}

function armDir(issue: number, condition: CodingCondition): string {
  return path.join(WORK_ROOT, `t${issue}-${condition}`);
}

function prepareWorktree(issue: number, condition: CodingCondition, base: string): string {
  const dir = armDir(issue, condition);
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'add', '-q', '--detach', dir, base], { cwd: REPO_ROOT });
  const modules = path.join(dir, 'node_modules');
  if (!fs.existsSync(modules)) {
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), modules, 'dir');
  }
  return dir;
}

/** Run one arm through ginsu, which owns the per-engine CLI invocation. */
function runArm(issue: number, condition: CodingCondition, dir: string, prompt: string): void {
  const engine = condition === 'claude-alone' ? 'claude' : 'codex';
  const worker = `bc${issue}${condition.replace(/[^a-z]/g, '')}`;
  spawnSync('ginsu', ['spawn', worker, dir, '--engine', engine], { encoding: 'utf-8' });
  spawnSync('ginsu', ['send', worker, prompt], {
    encoding: 'utf-8',
    env: { ...process.env, GINSU_TIMEOUT: '2400' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (condition === 'o8-governed') {
    spawnSync('ginsu', ['send', worker, REVIEW_TRACE], {
      encoding: 'utf-8',
      env: { ...process.env, GINSU_TIMEOUT: '2400' },
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  spawnSync('ginsu', ['stop', worker], { encoding: 'utf-8' });
}

function captureDiff(dir: string, out: string): void {
  execFileSync('git', ['add', '-A', '--', ':!node_modules', ':!implementation-notes.md'], { cwd: dir });
  const diff = execFileSync('git', ['diff', '--cached'], {
    cwd: dir, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(out, diff);
  execFileSync('git', ['reset', '-q'], { cwd: dir });
}

function collect(tasks: CodingTask[]): void {
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  for (const task of tasks) {
    const issue = issueText(task.issue);
    for (const condition of CODING_CONDITIONS) {
      const dir = prepareWorktree(task.issue, condition, task.base);
      const brief = condition === 'o8-governed'
        ? `${RAW_BRIEF}\n${GOVERNED_EXTRA}\n\n---\n\n${issue}`
        : `${RAW_BRIEF}\n\n---\n\n${issue}`;
      console.log(`[coding] running ${condition} on #${task.issue}`);
      runArm(task.issue, condition, dir, brief);
      captureDiff(dir, path.join(WORK_ROOT, `raw-${task.issue}-${condition}.diff`));
    }
  }
}

/** Deterministic shuffle so a run is reproducible from its seed. */
function seededShuffle(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
}

const JUDGE_PROMPT = `You are an impartial code reviewer scoring candidate diffs for the SAME GitHub issue.
You do not know which tool produced any of them. Judge only the code; do not speculate
about authorship.

All diffs already pass \`npx tsc --noEmit\` and eslint, so mechanical correctness tells
you nothing. Find what the compiler cannot see: a guard that can never fire, a branch
nothing reaches, a requirement silently unimplemented, state leaking across repos.

Score each 0-10 as the mean of four equally weighted sub-scores:
  correctness      — does it do what the issue asked, on the real code path?
  scopeDiscipline  — every changed line traceable to the request; penalize unrequested
                     refactors AND missed sub-requirements equally
  robustness       — error paths, edge cases, no state leaks
  fit              — matches surrounding conventions

Do not assume the longest diff is best or the shortest most elegant. Decide on evidence.

Write ONLY a JSON array to the output file, one object per diff:
[{"blindLabel":"A","subScores":{"correctness":0,"scopeDiscipline":0,"robustness":0,"fit":0},"mostSeriousDefect":"..."}]`;

function judgeTask(
  task: CodingTask,
  inputs: { blindLabel: string; diffPath: string }[],
  outFile: string,
): CodingVerdict[] {
  const listing = inputs.map((i) => `- ${i.blindLabel}: ${i.diffPath}`).join('\n');
  const prompt = `${JUDGE_PROMPT}

ISSUE TEXT: ${path.join(WORK_ROOT, `issue-${task.issue}.md`)}
DIFFS TO SCORE:
${listing}

Write the JSON array to: ${outFile}
Write the file even if you are uncertain — a missing file is a lost verdict.`;

  const worker = `bjudge${task.issue}`;
  spawnSync('ginsu', ['spawn', worker, REPO_ROOT, '--engine', 'codex'], { encoding: 'utf-8' });
  spawnSync('ginsu', ['send', worker, prompt], {
    encoding: 'utf-8',
    env: { ...process.env, GINSU_TIMEOUT: '1800' },
    maxBuffer: 16 * 1024 * 1024,
  });
  spawnSync('ginsu', ['stop', worker], { encoding: 'utf-8' });

  if (!fs.existsSync(outFile)) {
    console.warn(`[coding] judge produced no verdict file for #${task.issue} — task skipped`);
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(outFile, 'utf-8')) as Array<{
    blindLabel: string;
    subScores: CodingVerdict['subScores'];
    mostSeriousDefect?: string;
  }>;
  return parsed.map((entry) => ({
    task: task.issue,
    blindLabel: entry.blindLabel,
    subScores: entry.subScores,
    total: meanSubScores(entry.subScores),
    mostSeriousDefect: entry.mostSeriousDefect ?? '',
  }));
}

function judge(tasks: CodingTask[]): void {
  const verdicts: CodingVerdict[] = [];
  const mappings: Record<number, Record<string, CodingCondition>> = {};
  const shuffle = seededShuffle(Number(process.env.O8_BENCH_SEED ?? 20260802));

  for (const task of tasks) {
    const available: Record<string, string> = {};
    for (const condition of CODING_CONDITIONS) {
      const raw = path.join(WORK_ROOT, `raw-${task.issue}-${condition}.diff`);
      if (!fs.existsSync(raw)) continue;
      const blindDir = path.join(WORK_ROOT, 'blind');
      fs.mkdirSync(blindDir, { recursive: true });
      const scrubbed = path.join(blindDir, `t${task.issue}-${condition}.diff`);
      fs.writeFileSync(scrubbed, scrubAuthorship(fs.readFileSync(raw, 'utf-8')));
      available[condition] = scrubbed;
    }
    if (Object.keys(available).length < 2) {
      console.warn(`[coding] #${task.issue}: fewer than two arms produced a diff — skipped`);
      continue;
    }

    const { inputs, mapping } = blindCodingDiffs(task.issue, available, shuffle);
    // Re-file under the neutral label so the judge never sees a condition name.
    const relabelled = inputs.map((input) => {
      const dest = path.join(WORK_ROOT, 'blind', `task${task.issue}-${input.blindLabel}.diff`);
      fs.copyFileSync(input.diffPath, dest);
      return { blindLabel: input.blindLabel, diffPath: dest };
    });
    mappings[task.issue] = mapping;
    fs.writeFileSync(path.join(WORK_ROOT, `issue-${task.issue}.md`), issueText(task.issue));

    verdicts.push(
      ...judgeTask(task, relabelled, path.join(WORK_ROOT, `verdict-${task.issue}.json`)),
    );
  }

  const summary = scoreCodingResults(tasks, verdicts, mappings);
  fs.mkdirSync(LATEST_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(LATEST_DIR, 'coding.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), ...summary }, null, 2),
  );

  console.log(`[coding] tasks scored: ${summary.tasksScored}`);
  for (const result of summary.results) {
    const scores = Object.entries(result.scores)
      .map(([condition, value]) => `${condition}=${value}`).join('  ');
    console.log(
      `[coding] #${result.task} ${scores}  winner=${result.winner}` +
      `  margin=${result.margin}${result.decisive ? '' : ' (within noise)'}`,
    );
  }
  console.log(`[coding] wins: ${JSON.stringify(summary.wins)}`);
  console.log(`[coding] decisive wins: ${JSON.stringify(summary.decisiveWins)}`);
  console.log(
    `[coding] governed pipeline improves first-diff quality: ` +
    `${summary.governedImprovesQuality ? 'YES' : 'NO'} (pre-registered bar: >=2 decisive wins)`,
  );
  console.log(`[coding] ${summary.note}`);
}

function main(): void {
  const tasks = readTasks();
  const args = new Set(process.argv.slice(2));
  const doCollect = args.has('--collect') || args.size === 0;
  const doJudge = args.has('--judge') || args.size === 0;
  if (doCollect) collect(tasks);
  if (doJudge) judge(tasks);
}

main();
