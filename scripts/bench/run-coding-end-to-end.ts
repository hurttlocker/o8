import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { DurableReviewAssessment } from '../../src/lib/lane/durable-review-approval';
import { resolveRequireApprovalSync, type RequireApproval } from '../../src/lib/operator/defaults';
import type { CodingJudge } from './coding';
import {
  classifyArmStatus,
  countArmOutcomes,
  ginsuTurnStatus,
  type ArmClassification,
  type ArmErrorReceipt,
  type ArmOutcomeTotals,
} from './coding-arm-outcome';
import { benchmarkIssueText, readBenchmarkGitHubIssue } from './coding-github-issue';
import type { DurableReconciliationReceipt } from './coding-durable-reconciliation';
import {
  diffFactsFromUnifiedDiff,
  emptyEndToEndCommand,
  parseEndToEndJson,
  runEndToEndCommand,
  type EndToEndCommandReceipt,
  type EndToEndCommandResult,
} from './coding-end-to-end-command';
import {
  END_TO_END_CONDITIONS,
  endToEndMeasurementNotes,
  type EndToEndCondition,
  type EndToEndTask,
} from './coding-end-to-end';
import {
  GOVERNED_EXISTING_BRANCH_POLICY,
  governedMissionCreateArgs,
} from './coding-governed-mission';
import {
  preflightO8Cli,
  type O8CliResolutionReceipt,
} from './coding-o8-cli';
import {
  type DiffFacts,
  type GovernedPipelineOutcome,
  type GovernedReviewAttemptReceipt,
  type MechanicalReceipt,
} from './coding-end-to-end-review';
import {
  driveGovernedPipeline,
  MAX_GOVERNED_REVIEW_ATTEMPTS,
  type GovernedMergePreviewReceipt,
} from './coding-governed-pipeline';
import {
  assertEndToEndTaskSelection,
  endToEndTaskSelection,
  type EndToEndTaskSelectionReceipt,
} from './coding-end-to-end-tasks';
import { CODING_TASK_CONTRACT_FILE } from './coding-task-contract';
import { RAW_BRIEF } from './coding-prompts';
import { runBackendGuardedCollection, runningRunControl, type BenchmarkRunControlReceipt } from './coding-run-control';

export { readEndToEndTasks } from './coding-end-to-end-tasks';

const ARM_TIMEOUT_SECONDS = 2_400;
const MAX_DIFF_BYTES = 32 * 1024 * 1024;
export { MAX_GOVERNED_REVIEW_ATTEMPTS } from './coding-governed-pipeline';

export interface EndToEndArmReceipt extends ArmClassification {
  task: number;
  condition: EndToEndCondition;
  base: string;
  diffPath: string;
  issuePath: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  provenanceMarkers: string[];
  measurementNotes: string[];
  adhoc?: {
    runtime: CodingJudge;
    worktree: string;
    promptPath: string;
    replyPath: string;
    worker: string;
    spawn: EndToEndCommandReceipt;
    send: EndToEndCommandReceipt;
    stop: EndToEndCommandReceipt;
    mechanical: MechanicalReceipt;
  };
  governed?: {
    artifactKind: 'review-approved-output';
    artifactMerged: false;
    missionId: string | null;
    packetId: string | null;
    laneId: string | null;
    sessionKey: string | null;
    branch: string | null;
    worktree: string | null;
    create: EndToEndCommandReceipt;
    dispatch: EndToEndCommandReceipt;
    waitCommands: EndToEndCommandReceipt[];
    statusPolls: number;
    finalStatusCommand: EndToEndCommandReceipt | null;
    finalStatus: unknown;
    cost: unknown;
    maxReviewAttempts: number;
    reviewAttempts: GovernedReviewAttemptReceipt[];
    durableReview: DurableReviewAssessment | null;
    pipelineOutcome: GovernedPipelineOutcome;
    pipelineFailureReason: string | null;
    packetDiffCommand: EndToEndCommandReceipt | null;
    mergePreviewCommand: EndToEndCommandReceipt | null;
    mergePreview: GovernedMergePreviewReceipt | null;
    diffHeadSha: string | null;
    diffBase: string | null;
    diffTruncated: boolean;
    durableReconciliation: DurableReconciliationReceipt | null;
  };
}

export interface EndToEndCollectionReceipt {
  schema: 'o8/coding-end-to-end-collection/v1';
  runId: string;
  createdAt: string;
  baseCommit: string;
  approvalMode: RequireApproval;
  o8Cli: O8CliResolutionReceipt | null;
  governedExistingBranchPolicy: typeof GOVERNED_EXISTING_BRANCH_POLICY;
  taskSelection: EndToEndTaskSelectionReceipt;
  conditions: EndToEndCondition[];
  tasks: EndToEndTask[];
  arms: EndToEndArmReceipt[];
  outcomeTotals: ArmOutcomeTotals;
  runControl: BenchmarkRunControlReceipt;
}


export function currentBaseCommit(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'origin/main'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function currentBranch(repoRoot: string): string {
  return execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function issueText(repoRoot: string, issue: number): string {
  return benchmarkIssueText(repoRoot, issue);
}

export function preflightEndToEnd(repoRoot: string, tasks: EndToEndTask[]): {
  baseCommit: string;
  approvalMode: RequireApproval;
  o8Cli: O8CliResolutionReceipt;
} {
  assertEndToEndTaskSelection(tasks);
  if (currentBranch(repoRoot) !== 'main') {
    throw new Error('end-to-end benchmark must run from main');
  }
  for (const task of tasks) {
    const state = readBenchmarkGitHubIssue(repoRoot, task.issue).state.toUpperCase();
    if (state !== 'OPEN') throw new Error(`end-to-end issue #${task.issue} is not open`);
  }
  return {
    baseCommit: currentBaseCommit(repoRoot),
    approvalMode: resolveRequireApprovalSync(),
    o8Cli: preflightO8Cli(repoRoot),
  };
}

export function createEndToEndCollection(
  repoRoot: string,
  runId: string,
  tasks: EndToEndTask[],
): EndToEndCollectionReceipt {
  const { baseCommit, approvalMode, o8Cli } = preflightEndToEnd(repoRoot, tasks);
  if (approvalMode !== 'always') {
    throw new Error(
      `end-to-end collection requires requireApproval=always to hold the real pipeline before merge; current=${approvalMode}`,
    );
  }
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (status) throw new Error('end-to-end collection requires a clean main checkout');
  return {
    schema: 'o8/coding-end-to-end-collection/v1',
    runId,
    createdAt: new Date().toISOString(),
    baseCommit,
    approvalMode,
    o8Cli,
    governedExistingBranchPolicy: GOVERNED_EXISTING_BRANCH_POLICY,
    taskSelection: endToEndTaskSelection(tasks),
    conditions: [...END_TO_END_CONDITIONS],
    tasks: tasks.map((task) => ({ ...task })),
    arms: [],
    outcomeTotals: countArmOutcomes([]),
    runControl: runningRunControl(),
  };
}

function assertManagedWorktreePath(managedRoot: string, dir: string, expectedName: string): void {
  const resolvedRoot = path.resolve(managedRoot);
  const resolved = path.resolve(dir);
  if (resolved !== path.join(resolvedRoot, expectedName) || path.dirname(resolved) !== resolvedRoot) {
    throw new Error(`refusing unmanaged end-to-end worktree path: ${dir}`);
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`refusing end-to-end worktree symlink: ${resolved}`);
  }
}

function prepareDetachedWorktree(
  repoRoot: string,
  managedRoot: string,
  dir: string,
  expectedName: string,
  base: string,
): string {
  assertManagedWorktreePath(managedRoot, dir, expectedName);
  if (fs.existsSync(dir)) {
    const removal = runEndToEndCommand('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot });
    if (removal.receipt.status !== 0 || fs.existsSync(dir)) {
      throw new Error(`could not safely replace end-to-end worktree ${dir}`);
    }
  }
  execFileSync('git', ['worktree', 'add', '-q', '--detach', dir, base], { cwd: repoRoot });
  const modules = path.join(dir, 'node_modules');
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(repoRoot, 'node_modules'), modules, 'dir');
  return dir;
}

function stagedDiffFacts(dir: string, diffPath: string): DiffFacts {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['reset', '-q', '--', 'implementation-notes.md', CODING_TASK_CONTRACT_FILE], { cwd: dir });
  try {
    const diff = execFileSync('git', ['diff', '--cached', '--binary'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: MAX_DIFF_BYTES,
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
  const typecheck = runEndToEndCommand('npx', ['tsc', '--noEmit'], {
    cwd: dir,
    timeoutMs: 10 * 60 * 1_000,
  }).receipt;
  const lintedFiles = changedFiles.filter((file) => (
    /\.(?:[cm]?[jt]sx?)$/.test(file) && fs.existsSync(path.join(dir, file))
  ));
  const eslint = lintedFiles.length > 0
    ? runEndToEndCommand('npx', ['eslint', ...lintedFiles], {
        cwd: dir,
        timeoutMs: 10 * 60 * 1_000,
      }).receipt
    : null;
  return { typecheck, eslint, lintedFiles };
}

function collectAdhocArm(input: {
  repoRoot: string;
  workRoot: string;
  artifactDir: string;
  task: EndToEndTask;
  condition: 'adhoc-codex' | 'adhoc-claude';
  base: string;
  issue: string;
  issuePath: string;
}): EndToEndArmReceipt {
  const runtime: CodingJudge = input.condition === 'adhoc-claude' ? 'claude' : 'codex';
  const name = `e2e-t${input.task.issue}-${input.condition}`;
  const dir = prepareDetachedWorktree(
    input.repoRoot,
    input.workRoot,
    path.join(input.workRoot, name),
    name,
    input.base,
  );
  const promptPath = path.join(input.artifactDir, `prompt-${input.task.issue}-${input.condition}.md`);
  const replyPath = path.join(input.artifactDir, `reply-${input.task.issue}-${input.condition}.txt`);
  const diffPath = path.join(input.artifactDir, `shipped-${input.task.issue}-${input.condition}.diff`);
  const prompt = `${RAW_BRIEF}\n\n---\n\n${input.issue}`;
  fs.writeFileSync(promptPath, prompt);

  const worker = `be2e${input.task.issue}${runtime}`;
  const spawn = runEndToEndCommand('ginsu', ['spawn', worker, dir, '--engine', runtime], { cwd: input.repoRoot });
  let send: EndToEndCommandResult = { receipt: emptyEndToEndCommand('ginsu send'), stdout: '', stderr: '' };
  let stop: EndToEndCommandResult = { receipt: emptyEndToEndCommand('ginsu stop'), stdout: '', stderr: '' };
  if (spawn.receipt.status === 0) {
    try {
      send = runEndToEndCommand('ginsu', ['send', worker, prompt], {
        cwd: input.repoRoot,
        env: { ...process.env, GINSU_TIMEOUT: String(ARM_TIMEOUT_SECONDS) },
        timeoutMs: (ARM_TIMEOUT_SECONDS + 60) * 1_000,
      });
    } finally {
      stop = runEndToEndCommand('ginsu', ['stop', worker], { cwd: input.repoRoot, timeoutMs: 60_000 });
    }
  }
  fs.writeFileSync(replyPath, send.stdout);
  const diffFacts = stagedDiffFacts(dir, diffPath);
  const mechanical = runMechanicalChecks(dir, diffFacts.changedFiles);
  const measurementNotes = endToEndMeasurementNotes({
    condition: input.condition,
    expectedBase: input.base,
    changedFiles: diffFacts.changedFiles,
    commandsPassed: [spawn, send, stop].every((result) => result.receipt.status === 0),
    mechanicalPassed: mechanical.typecheck.status === 0 && (!mechanical.eslint || mechanical.eslint.status === 0),
    durableReviewApproved: null,
    reviewAttempts: 0,
    maxReviewAttempts: MAX_GOVERNED_REVIEW_ATTEMPTS,
    diffBase: null,
    diffTruncated: false,
    pipelineFailureReason: null,
  });
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
    task: input.task.issue,
    condition: input.condition,
    base: input.base,
    diffPath,
    issuePath: input.issuePath,
    ...diffFacts,
    provenanceMarkers: [dir, worker],
    ...classification,
    measurementNotes,
    adhoc: {
      runtime,
      worktree: dir,
      promptPath,
      replyPath,
      worker,
      spawn: spawn.receipt,
      send: send.receipt,
      stop: stop.receipt,
      mechanical,
    },
  };
}

async function collectGovernedArm(input: {
  repoRoot: string;
  o8CliPath: string;
  artifactDir: string;
  task: EndToEndTask;
  base: string;
  issue: string;
  issuePath: string;
}): Promise<EndToEndArmReceipt> {
  const approvalMode = resolveRequireApprovalSync();
  if (approvalMode !== 'always') {
    throw new Error(
      `governed arm requires requireApproval=always before mission creation; current=${approvalMode}`,
    );
  }
  const diffPath = path.join(input.artifactDir, `shipped-${input.task.issue}-governed.diff`);
  const missionTitle = input.issue.split('\n', 1)[0]?.replace(/^#\s*/, '') || input.task.label;
  const create = runEndToEndCommand(input.o8CliPath, governedMissionCreateArgs({
    title: missionTitle,
    body: input.issue,
    repoRoot: input.repoRoot,
    issue: input.task.issue,
  }), { cwd: input.repoRoot, timeoutMs: 2 * 60_000 });
  const streamErrors: ArmErrorReceipt[] = [];
  if (create.receipt.status !== 0) {
    streamErrors.push({ message: 'mission creation failed', willRetry: false });
  }

  let missionId: string | null = null;
  let packetId: string | null = null;
  if (create.receipt.status === 0) {
    try {
      const payload = parseEndToEndJson<{
        mission?: { missionId?: unknown; packets?: Array<{ id?: unknown }> };
      }>(
        create.stdout,
        'o8 mission create',
      );
      missionId = typeof payload.mission?.missionId === 'string' ? payload.mission.missionId : null;
      const packets = payload.mission?.packets ?? [];
      packetId = packets.length === 1 && typeof packets[0]?.id === 'string' ? packets[0].id : null;
    } catch (error) {
      // Mission creation is mutating, so ambiguous output is invalid and is never retried.
      streamErrors.push({
        message: error instanceof Error ? error.message : String(error),
        willRetry: false,
      });
    }
  }
  if (create.receipt.status === 0 && (!missionId || !packetId)) {
    streamErrors.push({ message: 'mission creation did not return one packet', willRetry: false });
  }

  const dispatch = missionId && packetId
    ? runEndToEndCommand(input.o8CliPath, ['mission', 'dispatch', '--mission', missionId, '--wait'], {
        cwd: input.repoRoot,
        timeoutMs: 10 * 60_000,
      })
    : { receipt: emptyEndToEndCommand(`${input.o8CliPath} mission dispatch`), stdout: '', stderr: '' };
  if (missionId && packetId && dispatch.receipt.status !== 0) {
    streamErrors.push({ message: 'mission dispatch failed', willRetry: false });
  }
  const pipeline = await driveGovernedPipeline({
    repoRoot: input.repoRoot,
    o8CliPath: input.o8CliPath,
    base: input.base,
    missionId,
    packetId,
    create: create.receipt,
    dispatch: dispatch.receipt,
    initialErrors: streamErrors,
  });
  fs.writeFileSync(diffPath, pipeline.shippedDiff);
  const diffFacts = diffFactsFromUnifiedDiff(pipeline.shippedDiff);
  const measurementNotes = endToEndMeasurementNotes({
    condition: 'governed',
    expectedBase: input.base,
    changedFiles: diffFacts.changedFiles,
    commandsPassed: pipeline.commandsPassed,
    mechanicalPassed: null,
    durableReviewApproved: pipeline.durableReview?.approved ?? false,
    reviewAttempts: pipeline.reviewAttempts.length,
    maxReviewAttempts: MAX_GOVERNED_REVIEW_ATTEMPTS,
    diffBase: pipeline.diffBase,
    diffTruncated: pipeline.diffTruncated,
    pipelineFailureReason: pipeline.pipelineFailureReason,
  });

  const statusMarkers = pipeline.finalStatus && typeof pipeline.finalStatus === 'object'
    ? JSON.stringify(pipeline.finalStatus).match(/(?:lane|pkt|mission)-[a-z0-9-]+/gi) ?? []
    : [];
  return {
    task: input.task.issue,
    condition: 'governed',
    base: input.base,
    diffPath,
    issuePath: input.issuePath,
    ...diffFacts,
    provenanceMarkers: [
      missionId,
      packetId,
      pipeline.laneId,
      pipeline.sessionKey,
      pipeline.branch,
      pipeline.worktree,
      ...statusMarkers,
    ]
      .filter((marker): marker is string => Boolean(marker)),
    ...pipeline.classification,
    measurementNotes,
    governed: {
      artifactKind: 'review-approved-output',
      artifactMerged: false,
      missionId,
      packetId,
      laneId: pipeline.laneId,
      sessionKey: pipeline.sessionKey,
      branch: pipeline.branch,
      worktree: pipeline.worktree,
      create: create.receipt,
      dispatch: dispatch.receipt,
      waitCommands: pipeline.waitCommands,
      statusPolls: pipeline.statusPolls,
      finalStatusCommand: pipeline.finalStatusCommand,
      finalStatus: pipeline.finalStatus,
      cost: pipeline.cost,
      maxReviewAttempts: MAX_GOVERNED_REVIEW_ATTEMPTS,
      reviewAttempts: pipeline.reviewAttempts,
      durableReview: pipeline.durableReview,
      pipelineOutcome: pipeline.pipelineOutcome,
      pipelineFailureReason: pipeline.pipelineFailureReason,
      packetDiffCommand: pipeline.packetDiffCommand,
      mergePreviewCommand: pipeline.mergePreviewCommand,
      mergePreview: pipeline.mergePreview,
      diffHeadSha: pipeline.diffHeadSha,
      diffBase: pipeline.diffBase,
      diffTruncated: pipeline.diffTruncated,
      durableReconciliation: pipeline.durableReconciliation,
    },
  };
}

export async function collectEndToEnd(input: {
  repoRoot: string;
  workRoot: string;
  collection: EndToEndCollectionReceipt;
  onUpdate: (collection: EndToEndCollectionReceipt) => void;
}): Promise<EndToEndCollectionReceipt> {
  if (!input.collection.o8Cli) {
    throw new Error('end-to-end collection is missing its preflight o8 CLI resolution receipt');
  }
  const o8CliPath = input.collection.o8Cli.resolvedPath;
  const artifactDir = path.join(input.workRoot, 'artifacts', 'end-to-end');
  fs.mkdirSync(artifactDir, { recursive: true });
  const issues = new Map<number, { issue: string; issuePath: string }>();
  const pendingArms = input.collection.tasks.flatMap((task) => (
    END_TO_END_CONDITIONS.map((condition) => ({ task, condition }))
  ));

  await runBackendGuardedCollection({
    arms: pendingArms,
    runArm: async ({ task, condition }) => {
      let issueInput = issues.get(task.issue);
      if (!issueInput) {
        const issue = issueText(input.repoRoot, task.issue);
        const issuePath = path.join(artifactDir, `issue-${task.issue}.md`);
        fs.writeFileSync(issuePath, issue);
        issueInput = { issue, issuePath };
        issues.set(task.issue, issueInput);
      }
      console.log(`[coding:e2e] collecting ${condition} on #${task.issue}`);
      const arm = condition === 'governed'
        ? await collectGovernedArm({
            repoRoot: input.repoRoot,
            o8CliPath,
            artifactDir,
            task,
            base: input.collection.baseCommit,
            issue: issueInput.issue,
            issuePath: issueInput.issuePath,
          })
        : collectAdhocArm({
            repoRoot: input.repoRoot,
            workRoot: input.workRoot,
            artifactDir,
            task,
            condition,
            base: input.collection.baseCommit,
            issue: issueInput.issue,
            issuePath: issueInput.issuePath,
          });
      return arm;
    },
    commitArm: (arm) => {
      input.collection.arms.push(arm);
      input.collection.outcomeTotals = countArmOutcomes(input.collection.arms);
      console.log(
        `[coding:e2e] ${arm.condition} outcome=${arm.outcome} files=${arm.changedFiles.length} ` +
        `+${arm.additions}/-${arm.deletions} notes=${arm.measurementNotes.join('; ') || 'none'}`,
      );
    },
    onRunControl: (receipt) => {
      input.collection.runControl = receipt;
      input.onUpdate(input.collection);
    },
  });
  return input.collection;
}
