/**
 * Merge preview — read-only wrapper around the merge gate (#623).
 *
 * Runs the policy checks plus a changed-file lint preflight and returns a
 * structured `{ checks[], blockers[] }` shape without touching the worktree
 * or issuing a merge commit. Used by the `o8_merge_preview` MCP tool so
 * orchestrator agents can "dry-run" a merge before committing to it.
 *
 * This is intentionally defensive: if the packet has no lane (archived,
 * never spawned, etc.) the preview returns a deterministic "unwired" shape
 * instead of throwing, so callers can distinguish "gate says no" from
 * "gate could not run".
 */

import { execFileSync } from 'node:child_process';

import { findLatestLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import type { PacketDiffBaseResolution } from '@/lib/diff/base-resolution';
import { runMergeGate, type MergeGateResult, type MergeViolation } from './merge-gate';
import { runLaneRebaseLint, type LaneRebaseLintResult } from './rebase-lint';
import { immutableSnapshotDiffBase, resolveLaneReviewSource } from './review-source';

// ── Public Types ──

/** One row per enforcement check, in the order listed below. */
export type MergeCheckName =
  | 'clean-worktree'
  | 'security-patterns'
  | 'diff-budget'
  | 'untracked-imports'
  | 'self-review-integrity'
  | 'typecheck'
  | 'lint';

export type MergeCheckVerdict = 'pass' | 'fail' | 'skipped';

export interface MergeCheckResult {
  name: MergeCheckName;
  verdict: MergeCheckVerdict;
  /** Human-readable detail for failing checks. Empty string when passing. */
  detail?: string;
}

/** Shape returned by `buildMergePreview` and by `o8_merge_preview`. */
export interface MergePreviewResult {
  packetId: string;
  /** True when the gate passed — a merge call would proceed past the gate. */
  wouldMerge: boolean;
  checks: MergeCheckResult[];
  /** Short category labels for every block-severity violation. */
  blockers: string[];
  branch: string | null;
  diffBase?: PacketDiffBaseResolution;
  reviewSource?: 'materialized' | 'immutable_snapshot';
  mergeUnavailableReason?: string;
  /** Populated when no lane is bound so the gate could not run. */
  unwired?: boolean;
}

interface MergePreviewOptions {
  orchestratorApproved?: boolean;
}

// ── Check-name mapping ──

const CATEGORY_TO_CHECK: Record<MergeViolation['category'], MergeCheckName> = {
  security: 'security-patterns',
  budget: 'diff-budget',
  integrity: 'self-review-integrity',
};

const ALL_CHECKS: MergeCheckName[] = [
  'clean-worktree',
  'security-patterns',
  'diff-budget',
  'untracked-imports',
  'self-review-integrity',
  'typecheck',
  'lint',
];

const POST_REBASE_CHECKS = new Set<MergeCheckName>(['typecheck', 'lint']);

// ── Shape translation ──

/**
 * Map a `MergeGateResult` into the structured preview shape.
 * Every check in `ALL_CHECKS` appears with a pass, fail, or skipped verdict.
 */
export function buildCheckList(
  result: MergeGateResult,
  verificationChecks: MergeCheckResult[] = [],
): MergeCheckResult[] {
  const firstViolationByCheck = new Map<MergeCheckName, MergeViolation>();
  for (const violation of result.violations) {
    if (violation.severity !== 'block') continue;
    // Integrity category covers both untracked-imports and self-review.
    // Disambiguate by label since both map to different check names.
    const check = resolveCheckName(violation);
    if (!firstViolationByCheck.has(check)) {
      firstViolationByCheck.set(check, violation);
    }
  }

  const verificationByName = new Map(verificationChecks.map((check) => [check.name, check]));

  return ALL_CHECKS.map((name) => {
    const verification = verificationByName.get(name);
    if (verification) return verification;
    if (POST_REBASE_CHECKS.has(name)) {
      return {
        name,
        verdict: 'skipped' as const,
        detail: 'Runs after rebase during approve_and_merge.',
      };
    }
    const violation = firstViolationByCheck.get(name);
    if (violation) {
      return { name, verdict: 'fail' as const, detail: violation.detail };
    }
    return { name, verdict: 'pass' as const };
  });
}

function resolveCheckName(violation: MergeViolation): MergeCheckName {
  if (violation.category !== 'integrity') {
    return CATEGORY_TO_CHECK[violation.category];
  }
  // Integrity violations come from two checks — the label distinguishes them.
  if (violation.label === 'Untracked imported files') {
    return 'untracked-imports';
  }
  if (violation.label === 'Operator checkout blocks base fast-forward') {
    return 'clean-worktree';
  }
  return 'self-review-integrity';
}

/** Derive a short blocker list from the gate result. Stable order, deduped. */
export function buildBlockerList(
  result: MergeGateResult,
  verificationChecks: MergeCheckResult[] = [],
): string[] {
  const seen = new Set<string>();
  const blockers: string[] = [];
  for (const check of buildCheckList(result, verificationChecks)) {
    if (check.verdict !== 'fail') continue;
    if (seen.has(check.name)) continue;
    seen.add(check.name);
    blockers.push(check.name);
  }
  return blockers;
}


function lintPreviewCheck(result: LaneRebaseLintResult): MergeCheckResult {
  if (!result.ok) return { name: 'lint', verdict: 'fail', detail: result.output };
  if (result.skipped) return { name: 'lint', verdict: 'skipped', detail: result.skipped };
  return { name: 'lint', verdict: 'pass', detail: result.detail };
}

// ── Preview runner ──

function hasApprovedOrchestratorReview(packetId: string): boolean {
  const mission = readOrchestratorControlPlaneState();
  return mission.packets.find((packet) => packet.id === packetId)?.review?.approved === true;
}

function readDirtyWorktreeDetail(cwd: string): string | null {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      windowsHide: true,
      cwd,
      timeout: 5000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    }).trim();
    if (!output) return null;
    const lines = output.split('\n').slice(0, 5);
    const suffix = output.split('\n').length > lines.length ? '\n...' : '';
    return `Uncommitted worktree changes are still present:\n${lines.join('\n')}${suffix}`;
  } catch {
    return 'Unable to verify that the worktree is clean.';
  }
}

/**
 * Run the merge gate against a lane and return the structured preview shape.
 * Callers already holding a `Lane` reference should use this path — it
 * avoids the extra `findLatestLaneByPacket` lookup.
 */
export async function buildPreviewForLane(
  lane: Lane,
  packetId: string,
  options: MergePreviewOptions = {},
): Promise<MergePreviewResult> {
  const reviewSource = await resolveLaneReviewSource(lane);
  if (reviewSource.kind === 'immutable_snapshot') {
    return {
      packetId,
      wouldMerge: false,
      checks: ALL_CHECKS.map((name) => ({ name, verdict: 'skipped' as const })),
      blockers: ['workspace-parked'],
      branch: reviewSource.branch,
      diffBase: immutableSnapshotDiffBase(reviewSource, lane.baseBranch),
      reviewSource: reviewSource.kind,
      mergeUnavailableReason: 'Restore the parked workspace and rerun verification before merge.',
    };
  }
  const resolvedLane = lane.worktreePath === reviewSource.cwd
    ? lane
    : { ...lane, worktreePath: reviewSource.cwd };
  const orchestratorApproved = options.orchestratorApproved ?? hasApprovedOrchestratorReview(packetId);
  const gateResult = await runMergeGate(resolvedLane, undefined, orchestratorApproved);
  const lint = await runLaneRebaseLint({
    cwd: reviewSource.cwd,
    baseRef: gateResult.diffBase?.mergeBase
      ?? gateResult.diffBase?.comparisonRef
      ?? lane.baseBranch,
    actualBranch: lane.branch ?? 'packet branch',
    logPrefix: 'merge-preview',
  });
  const verificationChecks: MergeCheckResult[] = [
    {
      name: 'typecheck',
      verdict: 'skipped',
      detail: 'Runs after rebase during approve_and_merge.',
    },
    lintPreviewCheck(lint),
  ];
  const checks = buildCheckList(gateResult, verificationChecks);
  const blockers = buildBlockerList(gateResult, verificationChecks);
  const dirtyDetail = readDirtyWorktreeDetail(reviewSource.cwd);
  if (dirtyDetail) {
    const cleanCheck = checks.find((check) => check.name === 'clean-worktree');
    if (cleanCheck) {
      cleanCheck.verdict = 'fail';
      cleanCheck.detail = dirtyDetail;
    }
    if (!blockers.includes('clean-worktree')) blockers.unshift('clean-worktree');
  }
  return {
    packetId,
    wouldMerge: gateResult.passed && lint.ok && !dirtyDetail,
    checks,
    blockers,
    branch: lane.branch ?? null,
    diffBase: gateResult.diffBase,
    reviewSource: reviewSource.kind,
  };
}

/**
 * Run the merge gate for a packet id and return the preview shape.
 * When the packet has no lane (archived / never spawned) returns a
 * deterministic "unwired" payload so callers can surface it cleanly.
 */
export async function previewPacketMerge(packetId: string): Promise<MergePreviewResult> {
  const lane = findLatestLaneByPacket(packetId);
  if (!lane) {
    return {
      packetId,
      wouldMerge: false,
      checks: ALL_CHECKS.map((name) => ({ name, verdict: 'skipped' as const })),
      blockers: ['no-lane'],
      branch: null,
      unwired: true,
    };
  }
  return buildPreviewForLane(lane, packetId);
}
