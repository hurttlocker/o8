/**
 * Paired coding benchmark runner.
 *
 * Phases are explicit because collection launches expensive external workers:
 *
 *   --preflight  verify fixed tasks, bases, and required CLIs without mutation
 *   --collect    run one raw and one contract-first arm per initial runtime
 *   --judge      blind complete task sets and score them with two judges
 *   --all        collect, then judge
 */

import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEVIATIONS_CLAUSE } from '../../src/lib/orchestrator/packet-deviations';
import {
  buildPacketTaskContractInstructions,
} from '../../src/lib/orchestrator/packet-task-contract';
import {
  CODING_CONDITIONS,
  CODING_JUDGES,
  CODING_RUNTIMES,
  type CodingCondition,
  type CodingRuntime,
  type CodingTask,
  type CodingVerdict,
  blindCodingDiffs,
  runtimeForCondition,
  scoreCodingResults,
  scrubAuthorship,
  treatmentForCondition,
} from './coding';
import type { EndToEndTask } from './coding-end-to-end';
import {
  classifyArmStatus,
  countArmOutcomes,
  ginsuTurnStatus,
  isScorableArmOutcome,
  type ArmClassification,
  type ArmErrorReceipt,
  type ArmOutcomeTotals,
} from './coding-arm-outcome';
import {
  CODING_TASK_CONTRACT_FILE,
  readCodingTaskContract,
} from './coding-task-contract';
import {
  assertUnusedCodingRunId,
  collectStandaloneEndToEnd,
  judgeStandaloneEndToEnd,
  preflightStandaloneEndToEnd,
} from './coding-end-to-end-cli';
import { createAbortedEndToEndCollection } from './coding-end-to-end-receipt';
import { o8CliPreflightSummary } from './coding-o8-cli';
import { runCodingJudge, type CodingJudgeReceipt } from './coding-judge-runner';
import { RAW_BRIEF } from './coding-prompts';
import {
  abortedRunControl,
  O8BackendAbortError,
  runBackendGuardedCollection,
  runningRunControl,
  withTemporaryRequireApproval,
  type BenchmarkRunControlReceipt,
} from './coding-run-control';
import { judgeEndToEnd } from './judge-coding-end-to-end';
import {
  collectEndToEnd,
  createEndToEndCollection,
  preflightEndToEnd,
  readEndToEndTasks,
  type EndToEndCollectionReceipt,
} from './run-coding-end-to-end';

const REPO_ROOT = process.cwd();
const TASKS_FILE = path.join(REPO_ROOT, 'tests/bench/coding/tasks.json');
const RUN_ID = (process.env.O8_BENCH_RUN_ID ?? 'contract-v1').trim();
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(RUN_ID)) {
  throw new Error('O8_BENCH_RUN_ID must contain only letters, numbers, dot, underscore, and hyphen');
}
const WORK_ROOT = path.join(os.tmpdir(), 'o8-bench-coding', RUN_ID);
const LATEST_DIR = path.join(REPO_ROOT, 'tests/bench/latest');
const COLLECTION_FILE = path.join(WORK_ROOT, 'collection.json');
const JUDGING_FILE = path.join(WORK_ROOT, 'judging.json');
const ARM_TIMEOUT_SECONDS = 2_400;
const JUDGE_TIMEOUT_SECONDS = 1_800;
const DEFAULT_SEED = 20_260_802;
let cachedRepoSlug: string | null = null;

const CONTRACT_INTERVENTION = [
  'Contract-first intervention:',
  ...buildPacketTaskContractInstructions(),
  `6. In addition to the assistant-message block, write the same contract JSON object, without tags or a Markdown fence, to ${CODING_TASK_CONTRACT_FILE} in the worktree root before any implementation edit. This artifact is mandatory and must remain unchanged after it is written.`,
  DEVIATIONS_CLAUSE,
].join('\n');

interface CommandReceipt {
  command: string;
  status: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  stderrBytes: number;
  spawnErrorCode: string | null;
}

interface MechanicalReceipt {
  typecheck: CommandReceipt;
  eslint: CommandReceipt | null;
  lintedFiles: string[];
}

interface ArmReceipt extends ArmClassification {
  task: number;
  condition: CodingCondition;
  runtime: CodingRuntime;
  treatment: 'raw' | 'contract';
  base: string;
  worktree: string;
  promptPath: string;
  replyPath: string;
  diffPath: string;
  turns: 1;
  repairTurns: 0;
  operatorInterventions: 0;
  timeoutSeconds: number;
  spawn: CommandReceipt;
  send: CommandReceipt;
  stop: CommandReceipt;
  contractObserved: boolean | null;
  changedFiles: string[];
  additions: number;
  deletions: number;
  mechanical: MechanicalReceipt;
  measurementNotes: string[];
}

interface CollectionReceipt {
  schema: 'o8/coding-collection/v2';
  runId: string;
  createdAt: string;
  seed: number;
  armTimeoutSeconds: number;
  conditions: CodingCondition[];
  arms: ArmReceipt[];
  outcomeTotals: ArmOutcomeTotals;
  endToEnd: EndToEndCollectionReceipt;
  runControl: BenchmarkRunControlReceipt;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readTasks(): CodingTask[] {
  const parsed = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) as { tasks?: CodingTask[] };
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('tests/bench/coding/tasks.json has no tasks');
  }
  for (const task of parsed.tasks) {
    if (!Number.isInteger(task.issue) || task.issue <= 0 || !task.base?.trim() || !task.label?.trim()) {
      throw new Error(`invalid coding task fixture: ${JSON.stringify(task)}`);
    }
  }
  return parsed.tasks;
}

function issueText(issue: number): string {
  if (!cachedRepoSlug) {
    cachedRepoSlug = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim();
  }
  if (!cachedRepoSlug) throw new Error('could not resolve the current repository slug');
  try {
    return execFileSync(
      'gh',
      ['issue', 'view', String(issue), '-R', cachedRepoSlug, '--json', 'title,body',
        '--jq', '"# " + .title + "\\n\\n" + .body'],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    ).trim();
  } catch {
    throw new Error(`could not read issue #${issue} through the authenticated repository CLI`);
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { receipt: CommandReceipt; stdout: string; stderr: string } {
  const startedAt = Date.now();
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  const errorCode = result.error && 'code' in result.error ? String(result.error.code) : '';
  return {
    receipt: {
      command: command === 'ginsu' && args[0] === 'send'
        ? `ginsu send ${args[1] ?? '(unknown)'} <PROMPT>`
        : [command, ...args].join(' '),
      status: result.status,
      signal: result.signal,
      durationMs: Date.now() - startedAt,
      timedOut: errorCode === 'ETIMEDOUT',
      stderrBytes: Buffer.byteLength(result.stderr || '', 'utf8'),
      spawnErrorCode: errorCode || null,
    },
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function seededShuffle(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  return <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(next() * (index + 1));
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
  };
}

function armDir(issue: number, condition: CodingCondition): string {
  return path.join(WORK_ROOT, `t${issue}-${condition}`);
}

function assertManagedWorktreePath(managedRoot: string, dir: string, expectedName: string): void {
  const resolvedRoot = path.resolve(managedRoot);
  const resolved = path.resolve(dir);
  const expected = path.join(resolvedRoot, expectedName);
  if (resolved !== expected || path.dirname(resolved) !== resolvedRoot || resolved === resolvedRoot) {
    throw new Error(`refusing unmanaged benchmark worktree path: ${dir}`);
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`refusing benchmark worktree symlink: ${resolved}`);
  }
}

function prepareDetachedWorktree(
  managedRoot: string,
  dir: string,
  expectedName: string,
  base: string,
): string {
  assertManagedWorktreePath(managedRoot, dir, expectedName);
  if (fs.existsSync(dir)) {
    const removal = runCommand('git', ['worktree', 'remove', '--force', dir], { cwd: REPO_ROOT });
    if (removal.receipt.status !== 0 || fs.existsSync(dir)) {
      throw new Error(`could not safely replace benchmark worktree ${dir}: ${removal.stderr.trim().slice(0, 500)}`);
    }
  }
  execFileSync('git', ['worktree', 'add', '-q', '--detach', dir, base], { cwd: REPO_ROOT });
  const modules = path.join(dir, 'node_modules');
  if (!fs.existsSync(modules)) {
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), modules, 'dir');
  }
  return dir;
}

function prepareArmWorktree(task: CodingTask, condition: CodingCondition): string {
  const name = `t${task.issue}-${condition}`;
  return prepareDetachedWorktree(WORK_ROOT, armDir(task.issue, condition), name, task.base);
}

function promptFor(condition: CodingCondition, issue: string): string {
  const treatment = treatmentForCondition(condition);
  return [
    RAW_BRIEF,
    treatment === 'contract' ? CONTRACT_INTERVENTION : null,
    '---',
    issue,
  ].filter((section): section is string => section !== null).join('\n\n');
}

function stagedDiffFacts(dir: string, diffPath: string): {
  changedFiles: string[];
  additions: number;
  deletions: number;
} {
  // Bare `git add -A` — passing any pathspec puts git in explicit mode, where a
  // gitignored match (the node_modules symlink each arm needs) warns and exits
  // non-zero, aborting the whole collection. Without a pathspec git silently
  // skips ignored paths, so benchmark-only artifacts are unstaged explicitly instead.
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync(
    'git',
    ['reset', '-q', '--', 'implementation-notes.md', CODING_TASK_CONTRACT_FILE],
    { cwd: dir },
  );
  try {
    const diff = execFileSync('git', ['diff', '--cached', '--binary'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(diffPath, diff);
    const changedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' })
      .split('\n').map((entry) => entry.trim()).filter(Boolean);
    const numstat = execFileSync('git', ['diff', '--cached', '--numstat'], { cwd: dir, encoding: 'utf8' });
    let additions = 0;
    let deletions = 0;
    for (const line of numstat.split('\n')) {
      const [added, deleted] = line.split('\t');
      if (/^\d+$/.test(added ?? '')) additions += Number(added);
      if (/^\d+$/.test(deleted ?? '')) deletions += Number(deleted);
    }
    return { changedFiles, additions, deletions };
  } finally {
    execFileSync('git', ['reset', '-q'], { cwd: dir });
  }
}

function runMechanicalChecks(dir: string, changedFiles: string[]): MechanicalReceipt {
  const typecheck = runCommand('npx', ['tsc', '--noEmit'], {
    cwd: dir,
    timeoutMs: 10 * 60 * 1_000,
  }).receipt;
  const lintedFiles = changedFiles.filter((file) => (
    /\.(?:[cm]?[jt]sx?)$/.test(file) && fs.existsSync(path.join(dir, file))
  ));
  const eslint = lintedFiles.length > 0
    ? runCommand('npx', ['eslint', ...lintedFiles], {
        cwd: dir,
        timeoutMs: 10 * 60 * 1_000,
      }).receipt
    : null;
  return { typecheck, eslint, lintedFiles };
}

function emptyCommand(command: string): CommandReceipt {
  return {
    command,
    status: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    stderrBytes: 0,
    spawnErrorCode: null,
  };
}

function runArm(task: CodingTask, condition: CodingCondition, issue: string): ArmReceipt {
  const runtime = runtimeForCondition(condition);
  const treatment = treatmentForCondition(condition);
  const dir = prepareArmWorktree(task, condition);
  const artifactDir = path.join(WORK_ROOT, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  const promptPath = path.join(artifactDir, `prompt-${task.issue}-${condition}.md`);
  const replyPath = path.join(artifactDir, `reply-${task.issue}-${condition}.txt`);
  const diffPath = path.join(artifactDir, `raw-${task.issue}-${condition}.diff`);
  const prompt = promptFor(condition, issue);
  fs.writeFileSync(promptPath, prompt);

  const worker = `bc${task.issue}${condition.replace(/[^a-z]/g, '')}`;
  const spawn = runCommand('ginsu', ['spawn', worker, dir, '--engine', runtime], { cwd: REPO_ROOT });
  let send = { receipt: emptyCommand('ginsu send'), stdout: '', stderr: '' };
  let stop = { receipt: emptyCommand('ginsu stop'), stdout: '', stderr: '' };
  if (spawn.receipt.status === 0) {
    try {
      send = runCommand('ginsu', ['send', worker, prompt], {
        cwd: REPO_ROOT,
        env: { ...process.env, GINSU_TIMEOUT: String(ARM_TIMEOUT_SECONDS) },
        timeoutMs: (ARM_TIMEOUT_SECONDS + 60) * 1_000,
      });
    } finally {
      stop = runCommand('ginsu', ['stop', worker], { cwd: REPO_ROOT, timeoutMs: 60_000 });
    }
  }
  fs.writeFileSync(replyPath, send.stdout);

  const contractObserved = treatment === 'contract'
    ? readCodingTaskContract(dir) !== null
    : null;
  const diffFacts = stagedDiffFacts(dir, diffPath);
  const mechanical = runMechanicalChecks(dir, diffFacts.changedFiles);
  const measurementNotes = [
    spawn.receipt.status !== 0 ? 'worker spawn failed' : null,
    send.receipt.status !== 0 ? 'worker turn failed' : null,
    stop.receipt.status !== 0 ? 'worker stop failed' : null,
    diffFacts.changedFiles.length === 0 ? 'no diff produced' : null,
    treatment === 'contract' && !contractObserved
      ? `task contract artifact ${CODING_TASK_CONTRACT_FILE} was missing, malformed, empty, or unmapped`
      : null,
    mechanical.typecheck.status !== 0 ? 'typecheck failed' : null,
    mechanical.eslint && mechanical.eslint.status !== 0 ? 'eslint failed' : null,
  ].filter((reason): reason is string => reason !== null);
  const errors: ArmErrorReceipt[] = [
    spawn.receipt.status !== 0 ? { message: 'worker spawn failed', willRetry: false } : null,
    send.receipt.status !== 0 ? { message: 'worker turn failed', willRetry: false } : null,
    stop.receipt.status !== 0 ? { message: 'worker stop failed', willRetry: false } : null,
  ].filter((error): error is ArmErrorReceipt => error !== null);
  const classification = classifyArmStatus({
    status: spawn.receipt.status === 0 ? ginsuTurnStatus({ ...send.receipt, ...send }) : null,
    source: 'stream',
    errors,
  });

  return {
    task: task.issue,
    condition,
    runtime,
    treatment,
    base: task.base,
    worktree: dir,
    promptPath,
    replyPath,
    diffPath,
    turns: 1,
    repairTurns: 0,
    operatorInterventions: 0,
    timeoutSeconds: ARM_TIMEOUT_SECONDS,
    spawn: spawn.receipt,
    send: send.receipt,
    stop: stop.receipt,
    contractObserved,
    ...diffFacts,
    mechanical,
    ...classification,
    measurementNotes,
  };
}

function collectionSeed(): number {
  const parsed = Number(process.env.O8_BENCH_SEED ?? DEFAULT_SEED);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error('O8_BENCH_SEED must be an unsigned 32-bit integer');
  }
  return parsed;
}

async function collectWhileApprovalHeld(
  tasks: CodingTask[],
  endToEndTasks: EndToEndTask[],
): Promise<CollectionReceipt> {
  const endToEnd = createEndToEndCollection(REPO_ROOT, RUN_ID, endToEndTasks);
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const seed = collectionSeed();
  const shuffle = seededShuffle(seed);
  const collection: CollectionReceipt = {
    schema: 'o8/coding-collection/v2',
    runId: RUN_ID,
    createdAt: new Date().toISOString(),
    seed,
    armTimeoutSeconds: ARM_TIMEOUT_SECONDS,
    conditions: [...CODING_CONDITIONS],
    arms: [],
    outcomeTotals: countArmOutcomes([]),
    endToEnd,
    runControl: runningRunControl(),
  };
  writeJson(COLLECTION_FILE, collection);

  const issues = new Map<number, string>();
  const pendingArms = tasks.flatMap((task) => (
    shuffle(CODING_CONDITIONS).map((condition) => ({ task, condition }))
  ));
  await runBackendGuardedCollection({
    arms: pendingArms,
    runArm: ({ task, condition }) => {
      let issue = issues.get(task.issue);
      if (!issue) {
        issue = issueText(task.issue);
        issues.set(task.issue, issue);
        fs.mkdirSync(path.join(WORK_ROOT, 'artifacts'), { recursive: true });
        fs.writeFileSync(path.join(WORK_ROOT, 'artifacts', `issue-${task.issue}.md`), issue);
      }
      console.log(`[coding] collecting ${condition} on #${task.issue}`);
      return runArm(task, condition, issue);
    },
    commitArm: (receipt) => {
      collection.arms.push(receipt);
      collection.outcomeTotals = countArmOutcomes(collection.arms);
      console.log(
        `[coding] ${receipt.condition} outcome=${receipt.outcome} files=${receipt.changedFiles.length} ` +
        `+${receipt.additions}/-${receipt.deletions} notes=${receipt.measurementNotes.join('; ') || 'none'}`,
      );
    },
    onRunControl: (receipt) => {
      collection.runControl = {
        ...receipt,
        status: receipt.status === 'completed' ? 'running' : receipt.status,
      };
      writeJson(COLLECTION_FILE, collection);
    },
  });
  await collectEndToEnd({
    repoRoot: REPO_ROOT,
    workRoot: WORK_ROOT,
    collection: endToEnd,
    onUpdate: (receipt) => {
      collection.endToEnd = receipt;
      collection.runControl = {
        ...receipt.runControl,
        status: receipt.runControl.status === 'completed' ? 'running' : receipt.runControl.status,
        completedArms: collection.arms.length + receipt.runControl.completedArms,
      };
      writeJson(COLLECTION_FILE, collection);
    },
  });
  collection.runControl = {
    status: 'completed',
    completedArms: collection.arms.length + collection.endToEnd.arms.length,
    abortReason: null,
    backendDetail: null,
    backendProbe: collection.endToEnd.runControl.backendProbe,
  };
  writeJson(COLLECTION_FILE, collection);
  return collection;
}

async function collect(
  tasks: CodingTask[],
  endToEndTasks = readEndToEndTasks(REPO_ROOT),
): Promise<CollectionReceipt> {
  assertUnusedCodingRunId(WORK_ROOT, RUN_ID);
  try {
    return await withTemporaryRequireApproval(() => collectWhileApprovalHeld(tasks, endToEndTasks));
  } catch (error) {
    if (error instanceof O8BackendAbortError && !fs.existsSync(COLLECTION_FILE)) {
      const endToEnd = createAbortedEndToEndCollection(REPO_ROOT, RUN_ID, endToEndTasks, error);
      const collection: CollectionReceipt = {
        schema: 'o8/coding-collection/v2',
        runId: RUN_ID,
        createdAt: new Date().toISOString(),
        seed: collectionSeed(),
        armTimeoutSeconds: ARM_TIMEOUT_SECONDS,
        conditions: [...CODING_CONDITIONS],
        arms: [],
        outcomeTotals: countArmOutcomes([]),
        endToEnd,
        runControl: abortedRunControl(error),
      };
      fs.mkdirSync(WORK_ROOT, { recursive: true });
      writeJson(COLLECTION_FILE, collection);
    }
    throw error;
  }
}

function readCollection(): CollectionReceipt {
  const parsed = JSON.parse(fs.readFileSync(COLLECTION_FILE, 'utf8')) as CollectionReceipt;
  if (parsed.schema !== 'o8/coding-collection/v2'
    || parsed.runId !== RUN_ID
    || !Array.isArray(parsed.arms)
    || parsed.endToEnd?.schema !== 'o8/coding-end-to-end-collection/v1'
    || parsed.endToEnd.runId !== RUN_ID) {
    throw new Error('collection.json is missing or uses an unsupported schema');
  }
  if (parsed.runControl?.status === 'infrastructure-aborted') {
    throw new Error(
      `${parsed.runControl.abortReason ?? 'coding collection infrastructure-aborted'}; ` +
      `arms completed before abort=${parsed.runControl.completedArms}`,
    );
  }
  return parsed;
}

function judge(tasks: CodingTask[], collection: CollectionReceipt): void {
  if (fs.existsSync(JUDGING_FILE)) {
    throw new Error(
      `benchmark run ${RUN_ID} already has judging receipts; use a new run ID rather than replacing verdicts`,
    );
  }
  const verdicts: CodingVerdict[] = [];
  const judgeReceipts: CodingJudgeReceipt[] = [];
  const mappings: Record<number, Record<string, CodingCondition>> = {};
  const shuffle = seededShuffle(collection.seed);
  const judgingStartedAt = new Date().toISOString();
  writeJson(JUDGING_FILE, {
    schema: 'o8/coding-judging/v2',
    runId: RUN_ID,
    startedAt: judgingStartedAt,
    receipts: judgeReceipts,
    blindVerdicts: verdicts,
  });

  for (const task of tasks) {
    const available: Partial<Record<CodingCondition, string>> = {};
    for (const condition of CODING_CONDITIONS) {
      const receipt = collection.arms.find((arm) => (
        arm.task === task.issue && arm.condition === condition && isScorableArmOutcome(arm.outcome)
      ));
      if (receipt && fs.existsSync(receipt.diffPath)) available[condition] = receipt.diffPath;
    }
    if (Object.keys(available).length !== CODING_CONDITIONS.length) {
      console.warn(`[coding] #${task.issue}: incomplete scorable arm set; task excluded from scoring`);
      continue;
    }

    const blinded = blindCodingDiffs(task.issue, available, shuffle);
    mappings[task.issue] = blinded.mapping;

    for (const judgeRuntime of CODING_JUDGES) {
      const judgeScope = fs.mkdtempSync(path.join(os.tmpdir(), `o8-blind-${task.issue}-`));
      const inputDir = path.join(judgeScope, 'inputs');
      fs.mkdirSync(inputDir);
      fs.copyFileSync(
        path.join(WORK_ROOT, 'artifacts', `issue-${task.issue}.md`),
        path.join(inputDir, 'issue.md'),
      );
      const relabelled = blinded.inputs.map((input) => {
        const dest = path.join(inputDir, `${input.blindLabel}.diff`);
        fs.writeFileSync(dest, scrubAuthorship(fs.readFileSync(input.diffPath, 'utf8')));
        return { blindLabel: input.blindLabel, diffPath: dest };
      });
      const baseDir = prepareDetachedWorktree(judgeScope, path.join(judgeScope, 'base'), 'base', task.base);
      console.log(`[coding] judging #${task.issue} with judge ${judgeRuntime}`);
      const result = runCodingJudge({
        task,
        judge: judgeRuntime,
        inputs: relabelled,
        baseDir,
        repoRoot: REPO_ROOT,
        workRoot: WORK_ROOT,
        timeoutSeconds: JUDGE_TIMEOUT_SECONDS,
        runCommand,
      });
      verdicts.push(...result.verdicts);
      judgeReceipts.push(result.receipt);
      writeJson(JUDGING_FILE, {
        schema: 'o8/coding-judging/v2',
        runId: RUN_ID,
        startedAt: judgingStartedAt,
        receipts: judgeReceipts,
        blindVerdicts: verdicts,
      });
    }
  }

  const summary = scoreCodingResults(tasks, verdicts, mappings);
  const endToEnd = judgeEndToEnd({
    repoRoot: REPO_ROOT,
    workRoot: WORK_ROOT,
    seed: collection.seed,
    collection: collection.endToEnd,
  });
  fs.mkdirSync(LATEST_DIR, { recursive: true });
  writeJson(path.join(LATEST_DIR, 'coding.json'), {
    schema: 'o8/coding-benchmark/v2',
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    protocol: {
      seed: collection.seed,
      paired: true,
      conditions: CODING_CONDITIONS,
      judges: CODING_JUDGES,
      turnsPerArm: 1,
      repairTurnsPerArm: 0,
      armTimeoutSeconds: ARM_TIMEOUT_SECONDS,
      judgeTimeoutSeconds: JUDGE_TIMEOUT_SECONDS,
      mappingUnsealedAfterAllVerdicts: true,
      rawAndTreatmentShareTaskBaseRulesAndBudget: true,
    },
    collection,
    outcomeTotals: countArmOutcomes([...collection.arms, ...collection.endToEnd.arms]),
    judging: { receipts: judgeReceipts, mappings },
    endToEnd,
    ...summary,
  });
  writeJson(JUDGING_FILE, {
    schema: 'o8/coding-judging/v2',
    runId: RUN_ID,
    startedAt: judgingStartedAt,
    completedAt: new Date().toISOString(),
    receipts: judgeReceipts,
    blindVerdicts: verdicts,
  });

  console.log(`[coding] complete tasks scored: ${summary.tasksScored}`);
  for (const result of summary.results) {
    for (const runtime of CODING_RUNTIMES) {
      const pair = result.pairs[runtime];
      const rawCondition = `${runtime}-raw` as CodingCondition;
      const contractCondition = `${runtime}-contract` as CodingCondition;
      const perJudge = CODING_JUDGES.map((judgeRuntime) => (
        `${judgeRuntime}:raw=${result.judgeScores[rawCondition][judgeRuntime]}` +
        `,contract=${result.judgeScores[contractCondition][judgeRuntime]}`
      )).join(' ');
      console.log(
        `[coding] #${result.task} ${runtime} ${perJudge} ` +
        `average:raw=${pair.raw},contract=${pair.contract} margin=${pair.contractMargin} ` +
        `judgeAgreement=${pair.judgeAgreement} outcome=${pair.outcome} decisive=${pair.decisive}`,
      );
    }
  }
  console.log(`[coding] paired summary: ${JSON.stringify(summary.paired)}`);
  console.log(`[coding] contract-first clears product bar: ${summary.contractImprovesQuality ? 'YES' : 'NO'}`);
  console.log(`[coding] ${summary.note}`);
}

function preflight(tasks: CodingTask[], endToEndTasks: EndToEndTask[]): void {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  if (path.resolve(root) !== path.resolve(REPO_ROOT)) {
    throw new Error(`run the coding benchmark from the repository root: ${root}`);
  }
  if (!fs.existsSync(path.join(REPO_ROOT, 'node_modules'))) {
    throw new Error('node_modules is missing; run npm install before the benchmark');
  }
  for (const command of ['ginsu', 'gh']) {
    const check = runCommand(command, ['--help'], { cwd: REPO_ROOT, timeoutMs: 30_000 });
    if (check.receipt.status !== 0) throw new Error(`${command} is unavailable`);
  }
  for (const task of tasks) {
    execFileSync('git', ['cat-file', '-e', `${task.base}^{commit}`], { cwd: REPO_ROOT });
    issueText(task.issue);
  }
  const endToEnd = preflightEndToEnd(REPO_ROOT, endToEndTasks);
  console.log(
    `[coding] preflight OK: ${tasks.length} fixed tasks, ${CODING_CONDITIONS.length} paired arms/task, ` +
    `${CODING_JUDGES.length} judges, seed=${collectionSeed()}, run=${RUN_ID}`,
  );
  console.log(
    `[coding:e2e] preflight OK: issues=${endToEndTasks.map((task) => task.issue).join(',')}, ` +
    `arms=3/task, base=${endToEnd.baseCommit}, ` +
    `approval=${endToEnd.approvalMode}, ${o8CliPreflightSummary(endToEnd.o8Cli)} ` +
    '(collection temporarily uses always)',
  );
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const allowed = new Set(['--preflight', '--collect', '--judge', '--all', '--e2e', '--e2e-judge']);
  const unknown = [...args].filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`unknown coding benchmark flag: ${unknown.join(', ')}`);
  const standaloneInput = { repoRoot: REPO_ROOT, workRoot: WORK_ROOT, runId: RUN_ID };
  if (args.has('--e2e') && args.has('--preflight') && args.size === 2) {
    preflightStandaloneEndToEnd(standaloneInput);
    return;
  }
  if (args.has('--e2e') && (args.size === 1 || (args.has('--collect') && args.size === 2))) {
    await collectStandaloneEndToEnd(standaloneInput);
    return;
  }
  if ((args.has('--e2e-judge') && args.size === 1)
    || (args.has('--e2e') && args.has('--judge') && args.size === 2)) {
    judgeStandaloneEndToEnd({
      ...standaloneInput,
      seed: collectionSeed(),
      latestDir: LATEST_DIR,
    });
    return;
  }
  if (args.size !== 1) {
    throw new Error(
      'choose one phase: --preflight, --collect, --judge, --all, --e2e, or --e2e-judge; ' +
      'use --preflight --e2e to check the standalone experiment without collecting',
    );
  }
  const tasks = readTasks();
  const endToEndTasks = readEndToEndTasks(REPO_ROOT);
  if (args.has('--preflight')) {
    preflight(tasks, endToEndTasks);
    return;
  }
  if (args.has('--collect')) {
    await collect(tasks, endToEndTasks);
    return;
  }
  if (args.has('--judge')) {
    judge(tasks, readCollection());
    return;
  }
  const collection = await collect(tasks, endToEndTasks);
  judge(tasks, collection);
}

void main();
