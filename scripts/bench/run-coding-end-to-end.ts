import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getApproval } from '../../src/lib/approvals/store';
import {
  assessDurableApprovedReview,
  type DurableReviewAssessment,
} from '../../src/lib/lane/durable-review-approval';
import { resolveRequireApprovalSync, type RequireApproval } from '../../src/lib/operator/defaults';
import type { CodingJudge } from './coding';
import {
  classifyArmStatus,
  countArmOutcomes,
  ginsuTurnStatus,
  TurnStatus,
  type ArmClassification,
  type ArmErrorReceipt,
  type ArmOutcomeTotals,
} from './coding-arm-outcome';
import {
  readDurablePacketState,
  reconcileArmWithDurableState,
  type DurableReconciliationReceipt,
} from './coding-durable-reconciliation';
import {
  diffFactsFromUnifiedDiff,
  emptyEndToEndCommand,
  jsonCommandWithReadRetries,
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
  refixFeedback,
  governedPipelineTerminalStatus,
  reviewAttemptFromStatus,
  reviewAttemptKey,
  type DiffFacts,
  type GovernedPipelineOutcome,
  type GovernedReviewAttemptReceipt,
  type MechanicalReceipt,
  type PacketDiffReceipt,
} from './coding-end-to-end-review';
import { assertExactEndToEndTasks } from './coding-end-to-end-tasks';
import { CODING_TASK_CONTRACT_FILE } from './coding-task-contract';
import { RAW_BRIEF } from './coding-prompts';
import { runBackendGuardedCollection, runningRunControl, type BenchmarkRunControlReceipt } from './coding-run-control';

export { readEndToEndTasks } from './coding-end-to-end-tasks';

const ARM_TIMEOUT_SECONDS = 2_400;
const GOVERNED_TIMEOUT_SECONDS = 7_200;
const GOVERNED_POLL_MS = 5_000;
export const MAX_GOVERNED_REVIEW_ATTEMPTS = 3;
const MAX_DIFF_BYTES = 32 * 1024 * 1024;

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
  governedExistingBranchPolicy: typeof GOVERNED_EXISTING_BRANCH_POLICY;
  conditions: EndToEndCondition[];
  tasks: EndToEndTask[];
  arms: EndToEndArmReceipt[];
  outcomeTotals: ArmOutcomeTotals;
  runControl: BenchmarkRunControlReceipt;
}


function currentBaseCommit(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function currentBranch(repoRoot: string): string {
  return execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function issueText(repoRoot: string, issue: number): string {
  const slug = execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  return execFileSync(
    'gh',
    ['issue', 'view', String(issue), '-R', slug, '--json', 'title,body',
      '--jq', '"# " + .title + "\\n\\n" + .body'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  ).trim();
}

export function preflightEndToEnd(repoRoot: string, tasks: EndToEndTask[]): {
  baseCommit: string;
  approvalMode: RequireApproval;
} {
  assertExactEndToEndTasks(tasks);
  if (currentBranch(repoRoot) !== 'main') {
    throw new Error('end-to-end benchmark must run from main');
  }
  const slug = execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  for (const task of tasks) {
    const state = execFileSync(
      'gh',
      ['issue', 'view', String(task.issue), '-R', slug, '--json', 'state', '--jq', '.state'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    if (state !== 'OPEN') throw new Error(`end-to-end issue #${task.issue} is not open`);
  }
  return { baseCommit: currentBaseCommit(repoRoot), approvalMode: resolveRequireApprovalSync() };
}

export function createEndToEndCollection(
  repoRoot: string,
  runId: string,
  tasks: EndToEndTask[],
): EndToEndCollectionReceipt {
  const { baseCommit, approvalMode } = preflightEndToEnd(repoRoot, tasks);
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
    governedExistingBranchPolicy: GOVERNED_EXISTING_BRANCH_POLICY,
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

function sleepPoll(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, GOVERNED_POLL_MS);
}

async function collectGovernedArm(input: {
  repoRoot: string;
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
  const create = runEndToEndCommand('o8', governedMissionCreateArgs({
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
    ? runEndToEndCommand('o8', ['mission', 'dispatch', '--mission', missionId, '--wait'], {
        cwd: input.repoRoot,
        timeoutMs: 10 * 60_000,
      })
    : { receipt: emptyEndToEndCommand('o8 mission dispatch'), stdout: '', stderr: '' };
  if (missionId && packetId && dispatch.receipt.status !== 0) {
    streamErrors.push({ message: 'mission dispatch failed', willRetry: false });
  }

  let statusPolls = 0;
  let finalStatusCommand: EndToEndCommandReceipt | null = null;
  let finalStatus: unknown = null;
  let cost: unknown = null;
  let laneId: string | null = null;
  let sessionKey: string | null = null;
  let branch: string | null = null;
  let worktree: string | null = null;
  let durableReview: DurableReviewAssessment | null = null;
  let pipelineOutcome: GovernedPipelineOutcome = null;
  let pipelineFailureReason: string | null = null;
  let packetDiffCommand: EndToEndCommandReceipt | null = null;
  let diffHeadSha: string | null = null;
  let diffBase: string | null = null;
  let diffTruncated = false;
  let shippedDiff = '';
  let readCommandsPassed = true;
  const reviewAttempts: GovernedReviewAttemptReceipt[] = [];
  const observedReviewKeys = new Set<string>();

  const deadline = Date.now() + GOVERNED_TIMEOUT_SECONDS * 1_000;
  while (missionId && packetId && dispatch.receipt.status === 0 && Date.now() < deadline) {
    const statusResult = jsonCommandWithReadRetries<{
      status?: {
        cost?: unknown;
        packets?: Array<{
          id?: unknown;
          status?: unknown;
          blockedReason?: unknown;
          lane?: {
            laneId?: unknown;
            branch?: unknown;
            repoPath?: unknown;
            sessionKey?: unknown;
            status?: unknown;
          } | null;
          review?: {
            approved?: unknown;
            summary?: unknown;
            recordedAt?: unknown;
            reviewedHeadSha?: unknown;
            auditApprovalId?: unknown;
          } | null;
        }>;
        agents?: Array<{
          packetId?: unknown;
          laneId?: unknown;
          sessionKey?: unknown;
          branch?: unknown;
          repoPath?: unknown;
        }>;
      };
    }>(
      'o8',
      ['mission', 'status', '--mission', missionId, '--cost'],
      input.repoRoot,
      'o8 mission status',
    );
    statusPolls += 1;
    streamErrors.push(...statusResult.errors);
    finalStatusCommand = statusResult.receipt;
    if (statusResult.receipt.status !== 0 || !statusResult.data) {
      readCommandsPassed = false;
      pipelineOutcome = 'stream-lost';
      pipelineFailureReason = 'mission status stream could not be read after three attempts';
      break;
    }
    const statusPayload = statusResult.data;
    finalStatus = statusPayload.status ?? null;
    cost = statusPayload.status?.cost ?? null;
    const packet = statusPayload.status?.packets?.find((candidate) => candidate.id === packetId);
    const packetStatus = typeof packet?.status === 'string' ? packet.status : '';
    laneId = typeof packet?.lane?.laneId === 'string' ? packet.lane.laneId : laneId;
    sessionKey = typeof packet?.lane?.sessionKey === 'string' ? packet.lane.sessionKey : sessionKey;
    branch = typeof packet?.lane?.branch === 'string' ? packet.lane.branch : branch;
    worktree = typeof packet?.lane?.repoPath === 'string' ? packet.lane.repoPath : worktree;
    const agent = statusPayload.status?.agents?.find((candidate) => (
      candidate.packetId === packetId || (laneId && candidate.laneId === laneId)
    ));
    sessionKey = typeof agent?.sessionKey === 'string' ? agent.sessionKey : sessionKey;
    branch = typeof agent?.branch === 'string' ? agent.branch : branch;
    worktree = typeof agent?.repoPath === 'string' ? agent.repoPath : worktree;

    const review = packet?.review ?? null;
    const key = review ? reviewAttemptKey(review) : null;
    if (review && key && !observedReviewKeys.has(key)) {
      observedReviewKeys.add(key);
      reviewAttempts.push(reviewAttemptFromStatus(reviewAttempts.length + 1, review));
    }
    const currentAttempt = key
      ? reviewAttempts.find((attempt) => attempt.approvalId === key)
        ?? reviewAttempts.at(-1)
        ?? null
      : null;

    if (laneId && worktree && review) {
      durableReview = await assessDurableApprovedReview({
        id: laneId,
        packetId,
        sessionKey,
        worktreePath: worktree,
        repoPath: input.repoRoot,
        baseBranch: 'main',
      });
      if (currentAttempt) currentAttempt.durableAssessment = durableReview;
    }

    if (durableReview?.approved === true && laneId && worktree) {
      const diffResult = jsonCommandWithReadRetries<PacketDiffReceipt>(
        'o8',
        ['packet', 'diff', packetId, '--max-bytes', String(MAX_DIFF_BYTES)],
        input.repoRoot,
        'o8 packet diff',
      );
      streamErrors.push(...diffResult.errors);
      packetDiffCommand = diffResult.receipt;
      if (diffResult.receipt.status !== 0 || !diffResult.data) {
        readCommandsPassed = false;
        pipelineOutcome = 'stream-lost';
        pipelineFailureReason = 'review-approved diff could not be read';
        break;
      }
      const postDiffAssessment = await assessDurableApprovedReview({
        id: laneId,
        packetId,
        sessionKey,
        worktreePath: worktree,
        repoPath: input.repoRoot,
        baseBranch: 'main',
      });
      durableReview = postDiffAssessment;
      if (currentAttempt) currentAttempt.durableAssessment = postDiffAssessment;
      const capturedHead = typeof diffResult.data.headSha === 'string' ? diffResult.data.headSha : null;
      const approvedRecord = postDiffAssessment.approvalId
        ? getApproval(postDiffAssessment.approvalId)
        : null;
      const approvedHead = typeof approvedRecord?.args?.reviewedHeadSha === 'string'
        ? approvedRecord.args.reviewedHeadSha
        : approvedRecord?.metadata?.['Reviewed HEAD'] ?? null;
      if (postDiffAssessment.approved && capturedHead !== null && capturedHead === approvedHead) {
        shippedDiff = typeof diffResult.data.diff === 'string' ? diffResult.data.diff : '';
        diffTruncated = diffResult.data.truncated === true;
        diffHeadSha = capturedHead;
        diffBase = diffResult.data.diffBase?.mergeBase
          ?? diffResult.data.diffBase?.comparisonRef
          ?? null;
        pipelineOutcome = 'review-approved';
        break;
      }
    }

    if (review?.approved === false && currentAttempt && currentAttempt.refix === null) {
      if (reviewAttempts.length >= MAX_GOVERNED_REVIEW_ATTEMPTS) {
        pipelineOutcome = 'review-bound-exhausted';
        break;
      }
      const assessment = durableReview ?? {
        approved: false,
        diffBudgetWaived: false,
        highConfidence: false,
        approvalId: null,
        reason: 'The review was rejected.',
      };
      const refix = runEndToEndCommand('o8', [
        'packet', 'rerun', '--packet', packetId, '--feedback', refixFeedback(currentAttempt, assessment),
      ], { cwd: input.repoRoot, timeoutMs: 10 * 60_000 });
      currentAttempt.refix = refix.receipt;
      if (refix.receipt.status !== 0) {
        streamErrors.push({ message: 'packet refix command failed', willRetry: false });
        pipelineOutcome = 'control-error';
        pipelineFailureReason = 'rejected review could not enter the normal refix loop';
        break;
      }
      durableReview = null;
      sleepPoll();
      continue;
    }

    if (packetStatus === 'released') {
      pipelineOutcome = 'released';
      pipelineFailureReason = 'pipeline released before the review-approved artifact was captured';
      break;
    }
    if (packetStatus === 'failed' || packetStatus === 'archived') {
      pipelineOutcome = 'failed';
      pipelineFailureReason = typeof packet?.blockedReason === 'string' ? packet.blockedReason : packetStatus;
      break;
    }
    if (packetStatus === 'blocked' && review?.approved !== false) {
      pipelineOutcome = 'blocked';
      pipelineFailureReason = typeof packet?.blockedReason === 'string' ? packet.blockedReason : 'packet blocked';
      break;
    }
    sleepPoll();
  }

  if (!pipelineOutcome && missionId && packetId && dispatch.receipt.status === 0) {
    pipelineOutcome = 'timeout';
    pipelineFailureReason = 'governed pipeline timed out before a durable approved review';
    streamErrors.push({ message: pipelineFailureReason, willRetry: false });
  }
  let streamStatus: TurnStatus | null = governedPipelineTerminalStatus(pipelineOutcome);
  if (streamStatus === null && (create.receipt.signal || dispatch.receipt.signal)) {
    streamStatus = TurnStatus.Interrupted;
  }
  let classification = classifyArmStatus({ status: streamStatus, source: 'stream', errors: streamErrors });
  let durableReconciliation: DurableReconciliationReceipt | null = null;
  if (packetId) {
    const durable = readDurablePacketState({ packetId, expectedBase: input.base });
    const reconciled = reconcileArmWithDurableState({ streamStatus, streamErrors, durable });
    classification = reconciled;
    durableReconciliation = reconciled.durableReconciliation;
    laneId = durable.laneId ?? laneId;
    sessionKey = durable.sessionKey ?? sessionKey;
    branch = durable.branch ?? branch;
    worktree = durable.worktreePath ?? worktree;
    if (durable.view === 'full' && durable.terminalStatus !== null) {
      shippedDiff = durable.recoveredDiff;
      diffHeadSha = durable.headSha;
      diffBase = durable.diffBase;
      diffTruncated = false;
    }
  }
  fs.writeFileSync(diffPath, shippedDiff);
  const diffFacts = diffFactsFromUnifiedDiff(shippedDiff);
  const commandsPassed = create.receipt.status === 0
    && Boolean(missionId)
    && Boolean(packetId)
    && dispatch.receipt.status === 0
    && readCommandsPassed
    && finalStatusCommand?.status === 0
    && reviewAttempts.every((attempt) => attempt.refix === null || attempt.refix.status === 0)
    && (pipelineOutcome !== 'review-approved' || packetDiffCommand?.status === 0);
  const measurementNotes = endToEndMeasurementNotes({
    condition: 'governed',
    expectedBase: input.base,
    changedFiles: diffFacts.changedFiles,
    commandsPassed,
    mechanicalPassed: null,
    durableReviewApproved: durableReview?.approved ?? false,
    reviewAttempts: reviewAttempts.length,
    maxReviewAttempts: MAX_GOVERNED_REVIEW_ATTEMPTS,
    diffBase,
    diffTruncated,
    pipelineFailureReason,
  });

  const statusMarkers = finalStatus && typeof finalStatus === 'object'
    ? JSON.stringify(finalStatus).match(/(?:lane|pkt|mission)-[a-z0-9-]+/gi) ?? []
    : [];
  return {
    task: input.task.issue,
    condition: 'governed',
    base: input.base,
    diffPath,
    issuePath: input.issuePath,
    ...diffFacts,
    provenanceMarkers: [missionId, packetId, laneId, sessionKey, branch, worktree, ...statusMarkers]
      .filter((marker): marker is string => Boolean(marker)),
    ...classification,
    measurementNotes,
    governed: {
      artifactKind: 'review-approved-output',
      artifactMerged: false,
      missionId,
      packetId,
      laneId,
      sessionKey,
      branch,
      worktree,
      create: create.receipt,
      dispatch: dispatch.receipt,
      statusPolls,
      finalStatusCommand,
      finalStatus,
      cost,
      maxReviewAttempts: MAX_GOVERNED_REVIEW_ATTEMPTS,
      reviewAttempts,
      durableReview,
      pipelineOutcome,
      pipelineFailureReason,
      packetDiffCommand,
      diffHeadSha,
      diffBase,
      diffTruncated,
      durableReconciliation,
    },
  };
}

export async function collectEndToEnd(input: {
  repoRoot: string;
  workRoot: string;
  collection: EndToEndCollectionReceipt;
  onUpdate: (collection: EndToEndCollectionReceipt) => void;
}): Promise<EndToEndCollectionReceipt> {
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
