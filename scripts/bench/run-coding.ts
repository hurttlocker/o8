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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDeviationsClause,
  packetImplementationNotesPath,
} from '../../src/lib/orchestrator/packet-deviations';
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
import { benchmarkIssueText } from './coding-github-issue';
import {
  runCodingCommand as runCommand,
  type CodingCommandReceipt as CommandReceipt,
} from './coding-command';
import {
  assertUnusedCodingRunId,
  collectStandaloneEndToEnd,
  judgeStandaloneEndToEnd,
  preflightStandaloneEndToEnd,
} from './coding-end-to-end-cli';
import { createAbortedEndToEndCollection } from './coding-end-to-end-receipt';
import { o8CliPreflightSummary } from './coding-o8-cli';
import { runCodingJudge, type CodingJudgeReceipt } from './coding-judge-runner';
import {
  pairedStagedDiffFacts,
  runPairedMechanicalChecks,
  type PairedMechanicalReceipt,
} from './coding-paired-mechanical';
import {
  assertPairedDependencySource,
  pairedWorkerName,
  preparePairedDetachedWorktree,
  type PairedDependencyPreparationReceipt,
} from './coding-paired-worktree';
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
const BENCHMARK_NOTES_PATH = packetImplementationNotesPath('benchmark-contract');

const CONTRACT_INTERVENTION = [
  'Contract-first intervention:',
  ...buildPacketTaskContractInstructions(BENCHMARK_NOTES_PATH),
  `6. In addition to the assistant-message block, write the same contract JSON object, without tags or a Markdown fence, to ${CODING_TASK_CONTRACT_FILE} in the worktree root before any implementation edit. This artifact is mandatory and must remain unchanged after it is written.`,
  buildDeviationsClause('benchmark-contract'),
].join('\n');

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
  worker: string;
  dependencies: PairedDependencyPreparationReceipt;
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
  mechanical: PairedMechanicalReceipt;
  measurementNotes: string[];
}

interface EndToEndNotCollectedReceipt {
  schema: 'o8/coding-end-to-end-not-collected/v1';
  runId: string;
  status: 'not-collected';
  reason: 'paired-only phase selected';
}

type CodingCollectionPhase = 'paired-only' | 'full';

interface CollectionReceipt {
  schema: 'o8/coding-collection/v2' | 'o8/coding-collection/v3';
  runId: string;
  phase?: CodingCollectionPhase;
  createdAt: string;
  seed: number;
  armTimeoutSeconds: number;
  conditions: CodingCondition[];
  arms: ArmReceipt[];
  outcomeTotals: ArmOutcomeTotals;
  endToEnd: EndToEndCollectionReceipt | EndToEndNotCollectedReceipt;
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
  return benchmarkIssueText(REPO_ROOT, issue);
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

function prepareDetachedWorktree(
  managedRoot: string,
  dir: string,
  expectedName: string,
  base: string,
): { path: string; dependencies: PairedDependencyPreparationReceipt } {
  return preparePairedDetachedWorktree({
    repoRoot: REPO_ROOT,
    managedRoot,
    dir,
    expectedName,
    base,
  });
}

function prepareArmWorktree(
  task: CodingTask,
  condition: CodingCondition,
): { path: string; dependencies: PairedDependencyPreparationReceipt } {
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
  const prepared = prepareArmWorktree(task, condition);
  const dir = prepared.path;
  const artifactDir = path.join(WORK_ROOT, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  const promptPath = path.join(artifactDir, `prompt-${task.issue}-${condition}.md`);
  const replyPath = path.join(artifactDir, `reply-${task.issue}-${condition}.txt`);
  const diffPath = path.join(artifactDir, `raw-${task.issue}-${condition}.diff`);
  const prompt = promptFor(condition, issue);
  fs.writeFileSync(promptPath, prompt);

  const worker = pairedWorkerName(RUN_ID, 'arm', task.issue, condition);
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
  const diffFacts = pairedStagedDiffFacts(
    dir,
    diffPath,
    ['implementation-notes.md', CODING_TASK_CONTRACT_FILE],
  );
  const mechanical = runPairedMechanicalChecks(dir, diffFacts.changedFiles, runCommand);
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
    worker,
    dependencies: prepared.dependencies,
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

function notCollectedEndToEnd(): EndToEndNotCollectedReceipt {
  return {
    schema: 'o8/coding-end-to-end-not-collected/v1',
    runId: RUN_ID,
    status: 'not-collected',
    reason: 'paired-only phase selected',
  };
}

function createCollection(
  phase: CodingCollectionPhase,
  endToEnd: CollectionReceipt['endToEnd'],
): CollectionReceipt {
  return {
    schema: 'o8/coding-collection/v3',
    runId: RUN_ID,
    phase,
    createdAt: new Date().toISOString(),
    seed: collectionSeed(),
    armTimeoutSeconds: ARM_TIMEOUT_SECONDS,
    conditions: [...CODING_CONDITIONS],
    arms: [],
    outcomeTotals: countArmOutcomes([]),
    endToEnd,
    runControl: runningRunControl(),
  };
}

function pairedArmCallbacks(collection: CollectionReceipt): {
  runArm: (input: { task: CodingTask; condition: CodingCondition }) => ArmReceipt;
  commitArm: (receipt: ArmReceipt) => void;
} {
  const issues = new Map<number, string>();
  return {
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
  };
}

function pairedArmPlan(tasks: CodingTask[], seed: number): Array<{
  task: CodingTask;
  condition: CodingCondition;
}> {
  const shuffle = seededShuffle(seed);
  return tasks.flatMap((task) => (
    shuffle(CODING_CONDITIONS).map((condition) => ({ task, condition }))
  ));
}

async function collectWhileApprovalHeld(
  tasks: CodingTask[],
  endToEndTasks: EndToEndTask[],
): Promise<CollectionReceipt> {
  const endToEnd = createEndToEndCollection(REPO_ROOT, RUN_ID, endToEndTasks);
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const collection = createCollection('full', endToEnd);
  writeJson(COLLECTION_FILE, collection);

  const callbacks = pairedArmCallbacks(collection);
  await runBackendGuardedCollection({
    arms: pairedArmPlan(tasks, collection.seed),
    ...callbacks,
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
  const completedEndToEnd = collection.endToEnd as EndToEndCollectionReceipt;
  collection.runControl = {
    status: 'completed',
    completedArms: collection.arms.length + completedEndToEnd.arms.length,
    abortReason: null,
    backendDetail: null,
    backendProbe: completedEndToEnd.runControl.backendProbe,
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
      const collection = createCollection('full', endToEnd);
      collection.runControl = abortedRunControl(error);
      fs.mkdirSync(WORK_ROOT, { recursive: true });
      writeJson(COLLECTION_FILE, collection);
    }
    throw error;
  }
}

function collectPairedOnly(tasks: CodingTask[]): CollectionReceipt {
  assertUnusedCodingRunId(WORK_ROOT, RUN_ID);
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const collection = createCollection('paired-only', notCollectedEndToEnd());
  const callbacks = pairedArmCallbacks(collection);
  writeJson(COLLECTION_FILE, collection);
  for (const arm of pairedArmPlan(tasks, collection.seed)) {
    callbacks.commitArm(callbacks.runArm(arm));
    collection.runControl = {
      status: 'running',
      completedArms: collection.arms.length,
      abortReason: null,
      backendDetail: null,
      backendProbe: null,
    };
    writeJson(COLLECTION_FILE, collection);
  }
  collection.runControl = {
    ...collection.runControl,
    status: 'completed',
  };
  writeJson(COLLECTION_FILE, collection);
  return collection;
}

function collectionPhase(collection: CollectionReceipt): CodingCollectionPhase {
  return collection.schema === 'o8/coding-collection/v2' ? 'full' : collection.phase ?? 'full';
}

function readCollection(): CollectionReceipt {
  const parsed = JSON.parse(fs.readFileSync(COLLECTION_FILE, 'utf8')) as CollectionReceipt;
  const supportedSchema = parsed.schema === 'o8/coding-collection/v2'
    || parsed.schema === 'o8/coding-collection/v3';
  const endToEndSchema = parsed.endToEnd?.schema;
  if (!supportedSchema
    || parsed.runId !== RUN_ID
    || !Array.isArray(parsed.arms)
    || (endToEndSchema !== 'o8/coding-end-to-end-collection/v1'
      && endToEndSchema !== 'o8/coding-end-to-end-not-collected/v1')
    || parsed.endToEnd.runId !== RUN_ID) {
    throw new Error('collection.json is missing or uses an unsupported schema');
  }
  if (parsed.runControl?.status === 'infrastructure-aborted') {
    throw new Error(
      `${parsed.runControl.abortReason ?? 'coding collection infrastructure-aborted'}; ` +
      `arms completed before abort=${parsed.runControl.completedArms}`,
    );
  }
  if (collectionPhase(parsed) === 'paired-only'
    && parsed.endToEnd.schema !== 'o8/coding-end-to-end-not-collected/v1') {
    throw new Error('paired-only collection must mark end-to-end data as not collected');
  }
  return parsed;
}

function judge(
  tasks: CodingTask[],
  collection: CollectionReceipt,
  requestedPhase: CodingCollectionPhase,
): void {
  const collectedPhase = collectionPhase(collection);
  if (collectedPhase !== requestedPhase) {
    throw new Error(
      `benchmark run ${RUN_ID} collected phase=${collectedPhase}; judge it with the matching phase flag`,
    );
  }
  if (requestedPhase === 'full'
    && collection.endToEnd.schema !== 'o8/coding-end-to-end-collection/v1') {
    throw new Error(`benchmark run ${RUN_ID} has no collected end-to-end data`);
  }
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
      const preparedBase = prepareDetachedWorktree(
        judgeScope,
        path.join(judgeScope, 'base'),
        'base',
        task.base,
      );
      console.log(`[coding] judging #${task.issue} with judge ${judgeRuntime}`);
      const result = runCodingJudge({
        runId: RUN_ID,
        task,
        judge: judgeRuntime,
        inputs: relabelled,
        baseDir: preparedBase.path,
        dependencyPreparation: preparedBase.dependencies,
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
  const endToEnd = requestedPhase === 'full'
    ? judgeEndToEnd({
        repoRoot: REPO_ROOT,
        workRoot: WORK_ROOT,
        seed: collection.seed,
        collection: collection.endToEnd as EndToEndCollectionReceipt,
      })
    : collection.endToEnd;
  const collectedEndToEndArms = collection.endToEnd.schema === 'o8/coding-end-to-end-collection/v1'
    ? collection.endToEnd.arms
    : [];
  fs.mkdirSync(LATEST_DIR, { recursive: true });
  writeJson(path.join(LATEST_DIR, 'coding.json'), {
    schema: 'o8/coding-benchmark/v3',
    runId: RUN_ID,
    phase: requestedPhase,
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
    outcomeTotals: countArmOutcomes([...collection.arms, ...collectedEndToEndArms]),
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

function preflightPaired(tasks: CodingTask[]): void {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  if (path.resolve(root) !== path.resolve(REPO_ROOT)) {
    throw new Error(`run the coding benchmark from the repository root: ${root}`);
  }
  assertPairedDependencySource(REPO_ROOT);
  for (const command of ['ginsu', 'gh']) {
    const check = runCommand(command, ['--help'], { cwd: REPO_ROOT, timeoutMs: 30_000 });
    if (check.receipt.status !== 0) throw new Error(`${command} is unavailable`);
  }
  for (const task of tasks) {
    execFileSync('git', ['cat-file', '-e', `${task.base}^{commit}`], { cwd: REPO_ROOT });
    issueText(task.issue);
  }
  console.log(
    `[coding] preflight OK: ${tasks.length} fixed tasks, ${CODING_CONDITIONS.length} paired arms/task, ` +
    `${CODING_JUDGES.length} judges, seed=${collectionSeed()}, run=${RUN_ID}`,
  );
}

function preflight(tasks: CodingTask[], endToEndTasks: EndToEndTask[]): void {
  preflightPaired(tasks);
  const endToEnd = preflightEndToEnd(REPO_ROOT, endToEndTasks);
  console.log(
    `[coding:e2e] preflight OK: issues=${endToEndTasks.map((task) => task.issue).join(',')}, ` +
    `arms=3/task, base=${endToEnd.baseCommit}, ` +
    `approval=${endToEnd.approvalMode}, ${o8CliPreflightSummary(endToEnd.o8Cli)} ` +
    '(collection temporarily uses always)',
  );
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const allowed = new Set([
    '--preflight', '--collect', '--judge', '--all', '--paired', '--e2e', '--e2e-judge',
  ]);
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
  if (args.has('--paired')) {
    const pairedPhases = ['--preflight', '--collect', '--judge', '--all']
      .filter((flag) => args.has(flag));
    if (args.size !== 2 || pairedPhases.length !== 1) {
      throw new Error('choose one paired-only phase: --paired --preflight|--collect|--judge|--all');
    }
    const tasks = readTasks();
    if (args.has('--preflight')) {
      assertUnusedCodingRunId(WORK_ROOT, RUN_ID);
      preflightPaired(tasks);
      console.log('[coding] paired-only phase selected; end-to-end data=not collected');
      return;
    }
    if (args.has('--collect')) {
      collectPairedOnly(tasks);
      return;
    }
    if (args.has('--judge')) {
      judge(tasks, readCollection(), 'paired-only');
      return;
    }
    const collection = collectPairedOnly(tasks);
    judge(tasks, collection, 'paired-only');
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
    judge(tasks, readCollection(), 'full');
    return;
  }
  const collection = await collect(tasks, endToEndTasks);
  judge(tasks, collection, 'full');
}

void main();
