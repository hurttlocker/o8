import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import { appendEvent, archiveLane, getLane, listLanes, updateLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import {
  readOrchestratorControlPlaneState,
  withLockedState,
} from '@/lib/orchestrator/control-plane';
import { MergedByAncestryBackoff } from '@/lib/orchestrator/merged-by-ancestry-backoff';
import { packetTerminalState } from '@/lib/orchestrator/packet-state';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { enqueueInboxItem } from '@/lib/supervisor/inbox';
import { autoResolveMergedPacketVerificationIncidents } from '@/lib/supervisor/merged-incident-resolution';

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_BRANCH = 'main';
const MERGED_BY_ANCESTRY_SOURCE = 'merged_by_ancestry_reconcile';

type MergeEvidenceKind = 'ancestor' | 'patch-id' | 'no-changes';
type NoChangesReason = 'branch_missing' | 'branch_matches_base';

interface MergeEvidence {
  kind: MergeEvidenceKind;
  repoPath: string;
  branchRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha?: string;
  patchId?: string;
  noChangesReason?: NoChangesReason;
}

interface Candidate {
  // null = lane-only candidate: a non-archived lane whose packet no longer
  // exists in live mission state (mission rotated/reset). These are exactly
  // the rows that sat in the rail forever — the sweep previously iterated
  // live packets only, so a lane orphaned from its mission was never healed.
  packet: OrchestratorPacket | null;
  lane: Lane | null;
  repoPath: string;
  branch: string;
  baseBranch: string;
  laneId: string | null;
}

// Lane statuses eligible for lane-only sweeping: settled states where no
// agent is actively working and no human prompt is pending. Active/attention
// states (running, merging, awaiting_*) are never touched. 'released' is not
// a LaneStatus enum value but exists in stored rows (packet vocabulary that
// leaked into lane status) — matched as a string on purpose.
const LANE_ONLY_SWEEPABLE_STATUSES = new Set<string>([
  'idle',
  'paused',
  'reviewing',
  'recovering',
  'failed',
  'completed',
  'released',
]);

export interface MergedByAncestrySweepResult {
  scanned: number;
  merged: number;
  skipped: number;
}

// #1498 — persists across sweeps so a lane whose detect() keeps timing out is
// parked with exponential backoff instead of re-spawning its expensive git
// pipeline every 30s tick.
const detectBackoff = new MergedByAncestryBackoff();

function candidateKey(candidate: Candidate): string {
  return candidate.laneId
    ?? (candidate.packet ? `packet:${candidate.packet.id}` : `repo:${candidate.repoPath}:${candidate.branch}`);
}

async function git(
  cwd: string,
  args: string[],
  options: { timeout?: number; input?: string } = {},
): Promise<string> {
  if (options.input !== undefined) {
    return gitWithInput(cwd, args, options.input, options.timeout ?? 8_000);
  }
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 8_000,
  });
  return stdout.trim();
}

function gitWithInput(
  cwd: string,
  args: string[],
  input: string,
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args.join(' ')} timed out`));
    }, timeout);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `git ${args.join(' ')} exited ${code ?? 'unknown'}`));
      }
    });
    child.stdin.end(input);
  });
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', ref], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--git-dir'], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function revParse(repoPath: string, ref: string): Promise<string | null> {
  try {
    return await git(repoPath, ['rev-parse', '--verify', ref], { timeout: 3_000 });
  } catch {
    return null;
  }
}

async function refreshOriginBase(repoPath: string, baseBranch: string): Promise<void> {
  try {
    await git(repoPath, ['fetch', '--quiet', 'origin', `${baseBranch}:refs/remotes/origin/${baseBranch}`], {
      timeout: 20_000,
    });
  } catch {
    // Best effort only. The proof step below must still verify readable refs.
  }
}

async function resolveBaseRef(repoPath: string, baseBranch: string): Promise<string | null> {
  const originRef = `origin/${baseBranch}`;
  if (await refExists(repoPath, originRef)) return originRef;
  if (await refExists(repoPath, baseBranch)) return baseBranch;
  return null;
}

async function resolveBranchRef(repoPath: string, branch: string): Promise<string | null> {
  if (await refExists(repoPath, branch)) return branch;
  const originRef = `origin/${branch}`;
  if (await refExists(repoPath, originRef)) return originRef;
  return null;
}

async function isAncestor(repoPath: string, headSha: string, baseRef: string): Promise<boolean> {
  try {
    await git(repoPath, ['merge-base', '--is-ancestor', headSha, baseRef], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function mergeBase(repoPath: string, branchRef: string, baseRef: string): Promise<string | null> {
  try {
    return await git(repoPath, ['merge-base', branchRef, baseRef], { timeout: 5_000 });
  } catch {
    return null;
  }
}

async function patchIdForDiff(repoPath: string, diffArgs: string[]): Promise<string | null> {
  const diff = await git(repoPath, ['diff', ...diffArgs], { timeout: 10_000 });
  if (!diff.trim()) return null;
  const patchOutput = await git(repoPath, ['patch-id', '--stable'], {
    input: `${diff}\n`,
    timeout: 10_000,
  });
  return patchOutput.split(/\s+/)[0] || null;
}

async function patchIdsForMainCommits(repoPath: string, range: string): Promise<Set<string>> {
  const shas = (await git(repoPath, ['log', '--format=%H', range], { timeout: 10_000 }))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const ids = new Set<string>();
  for (const sha of shas) {
    const diff = await git(repoPath, ['show', '--format=', '--no-ext-diff', sha], { timeout: 10_000 });
    if (!diff.trim()) continue;
    const output = await git(repoPath, ['patch-id', '--stable'], {
      input: `${diff}\n`,
      timeout: 10_000,
    });
    const patchId = output.split(/\s+/)[0];
    if (patchId) ids.add(patchId);
  }
  return ids;
}

async function squashPatchExistsOnBase(
  repoPath: string,
  branchRef: string,
  baseRef: string,
): Promise<{ merged: boolean; mergeBaseSha?: string; patchId?: string }> {
  const mergeBaseSha = await mergeBase(repoPath, branchRef, baseRef);
  if (!mergeBaseSha) return { merged: false };

  const aggregatePatchId = await patchIdForDiff(repoPath, [`${mergeBaseSha}..${branchRef}`]);
  if (!aggregatePatchId) return { merged: false, mergeBaseSha };

  const mainPatchIds = await patchIdsForMainCommits(repoPath, `${mergeBaseSha}..${baseRef}`);
  return {
    merged: mainPatchIds.has(aggregatePatchId),
    mergeBaseSha,
    patchId: aggregatePatchId,
  };
}

async function detectMergedByAncestry(candidate: Candidate): Promise<MergeEvidence | null> {
  const { repoPath, branch, baseBranch } = candidate;
  if (!branch) return null;

  await refreshOriginBase(repoPath, baseBranch);

  const branchRef = await resolveBranchRef(repoPath, branch);
  const baseRef = await resolveBaseRef(repoPath, baseBranch);
  const noChangesEligible = candidate.packet === null
    || candidate.packet.status === 'awaiting_review';
  if (!branchRef && baseRef && noChangesEligible) {
    // A settled lane whose branch resolves nowhere has no reviewable commit.
    // Preserve that terminal truth explicitly instead of archiving it as an
    // ambiguous branch-reconciliation cleanup.
    if (await isGitRepo(repoPath)) {
      const baseSha = await revParse(repoPath, baseRef);
      if (baseSha) {
        return {
          kind: 'no-changes',
          repoPath,
          branchRef: branch,
          baseRef,
          headSha: '',
          baseSha,
          noChangesReason: 'branch_missing',
        };
      }
    }
    return null;
  }
  if (!branchRef || !baseRef) return null;

  const [headSha, baseSha] = await Promise.all([
    revParse(repoPath, branchRef),
    revParse(repoPath, baseRef),
  ]);
  if (!headSha || !baseSha) return null;

  const publishedBranchExists = branch !== baseBranch
    && await refExists(repoPath, `origin/${branch}`);
  if (
    noChangesEligible
    && headSha === baseSha
    && (branch === baseBranch || !publishedBranchExists)
  ) {
    return {
      kind: 'no-changes',
      repoPath,
      branchRef,
      baseRef,
      headSha,
      baseSha,
      noChangesReason: 'branch_matches_base',
    };
  }

  if (await isAncestor(repoPath, headSha, baseRef)) {
    return {
      kind: 'ancestor',
      repoPath,
      branchRef,
      baseRef,
      headSha,
      baseSha,
    };
  }

  const patch = await squashPatchExistsOnBase(repoPath, branchRef, baseRef);
  if (!patch.merged) return null;

  return {
    kind: 'patch-id',
    repoPath,
    branchRef,
    baseRef,
    headSha,
    baseSha,
    mergeBaseSha: patch.mergeBaseSha,
    patchId: patch.patchId,
  };
}

function buildCandidates(): Candidate[] {
  const lanes = listLanes();
  const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
  const laneByPacket = new Map(lanes.filter((lane) => lane.packetId).map((lane) => [lane.packetId!, lane]));

  const packetCandidates = readOrchestratorControlPlaneState().packets
    .filter((packet) => {
      const terminal = packetTerminalState(packet);
      return terminal !== 'released' && terminal !== 'archived';
    })
    .map((packet) => {
      const laneId = packet.lane?.laneId?.trim() || null;
      const lane = (laneId ? laneById.get(laneId) ?? getLane(laneId) : null)
        ?? laneByPacket.get(packet.id)
        ?? null;
      const repoPath = lane?.repoPath
        || packet.lane?.repoPath?.trim()
        || packet.workspaceTargetPath?.trim()
        || '';
      const branch = lane?.branch || packet.branchTarget;
      const baseBranch = lane?.baseBranch || DEFAULT_BASE_BRANCH;
      return {
        packet,
        lane,
        repoPath,
        branch,
        baseBranch,
        laneId: lane?.id ?? laneId,
      };
    })
    .filter((candidate) => Boolean(candidate.repoPath && candidate.branch));

  // Lane-only pass: non-archived settled lanes with no packet in live mission
  // state. Prefer the worktree clone as the git cwd — dispatched branches
  // usually exist only there — falling back to the lane's canonical repo.
  const coveredLaneIds = new Set(packetCandidates.map((c) => c.laneId).filter(Boolean));
  const laneOnlyCandidates: Candidate[] = lanes
    .filter((lane) => (
      !coveredLaneIds.has(lane.id)
      && LANE_ONLY_SWEEPABLE_STATUSES.has(lane.status)
      && Boolean(lane.branch)
      && (lane.branch !== lane.baseBranch || Boolean(lane.packetId))
    ))
    .map((lane) => {
      const worktree = lane.worktreePath && existsSync(lane.worktreePath) ? lane.worktreePath : null;
      const repoPath = worktree || lane.repoPath || '';
      return {
        packet: null,
        lane,
        repoPath,
        branch: lane.branch,
        baseBranch: lane.baseBranch || DEFAULT_BASE_BRANCH,
        laneId: lane.id,
      };
    })
    .filter((candidate) => Boolean(candidate.repoPath && existsSync(candidate.repoPath)));

  return [...packetCandidates, ...laneOnlyCandidates];
}

async function releasePacket(candidate: Candidate, evidence: MergeEvidence): Promise<void> {
  const releasedAt = new Date().toISOString();
  if (candidate.packet) {
    const packetId = candidate.packet.id;
    await withLockedState((state) => {
      const packet = state.packets.find((item) => item.id === packetId);
      if (!packet) return;
      const terminal = packetTerminalState(packet);
      if (terminal === 'released' || terminal === 'archived') return;

      packet.status = 'released';
      packet.queueState = 'held';
      packet.releaseState = 'released';
      packet.releaseStatePayload = {
        ...(packet.releaseStatePayload ?? {}),
        mergeCommit: evidence.baseSha,
        releasedAt,
        source: MERGED_BY_ANCESTRY_SOURCE,
      };
      packet.blockedReason = null;
      packet.lastEventAt = releasedAt;
      packet.lastEventLabel = evidence.kind === 'ancestor'
        ? 'merged_by_ancestry'
        : 'merged_by_patch_id';
      if (packet.lane) {
        packet.lane.lastEventAt = releasedAt;
        packet.lane.lastEventLabel = packet.lastEventLabel;
      }
    });
  }

  if (candidate.laneId) {
    appendEvent(candidate.laneId, 'merged_by_ancestry_reconciled', 'system', {
      packetId: candidate.packet?.id ?? candidate.lane?.packetId ?? null,
      evidenceKind: evidence.kind,
      branchRef: evidence.branchRef,
      baseRef: evidence.baseRef,
      headSha: evidence.headSha,
      baseSha: evidence.baseSha,
      mergeBaseSha: evidence.mergeBaseSha ?? null,
      patchId: evidence.patchId ?? null,
    });
    archiveLane(candidate.laneId, 'system');
  }

  const incidentPacketId = candidate.packet?.id ?? candidate.lane?.packetId ?? null;
  if (incidentPacketId) {
    autoResolveMergedPacketVerificationIncidents({
      packetId: incidentPacketId,
      laneId: candidate.laneId,
      event: MERGED_BY_ANCESTRY_SOURCE,
    });
  }
}

async function finishWithoutChanges(candidate: Candidate, evidence: MergeEvidence): Promise<void> {
  const finishedAt = new Date().toISOString();
  const note = 'Agent finished without making changes';
  const packetId = candidate.packet?.id ?? candidate.lane?.packetId ?? null;
  const packetTitle = candidate.packet?.title ?? candidate.lane?.label ?? packetId ?? 'Dispatched packet';

  if (candidate.packet) {
    await withLockedState((state) => {
      const packet = state.packets.find((item) => item.id === candidate.packet?.id);
      if (!packet) return;
      packet.status = 'archived';
      packet.queueState = 'held';
      packet.blockedReason = null;
      packet.archivedAt = finishedAt;
      packet.lastEventAt = finishedAt;
      packet.lastEventLabel = 'finished_no_changes';
    });
  }

  if (candidate.laneId) {
    updateLane(candidate.laneId, {
      outcome: 'no_changes',
      outcomeNote: note,
      lastEventAt: finishedAt,
      lastEventLabel: 'finished_no_changes',
    }, 'system');
    appendEvent(candidate.laneId, 'status_change', 'system', {
      reason: evidence.noChangesReason === 'branch_missing'
        ? 'branch_missing_reconciled'
        : 'branch_matches_base_reconciled',
      outcome: 'no_changes',
      note,
      branch: evidence.branchRef,
      baseRef: evidence.baseRef,
      baseSha: evidence.baseSha,
      repoPath: evidence.repoPath,
    });
    archiveLane(candidate.laneId, 'system');
  }

  const repoPath = candidate.lane?.repoPath || evidence.repoPath;
  const repoName = basename(repoPath);
  enqueueInboxItem({
    repoPath,
    packetId,
    kind: 'packet_no_changes',
    status: 'pending',
    payload: {
      laneId: candidate.laneId,
      packetTitle,
      repoName,
      outcome: 'no_changes',
      note: `${packetTitle} in ${repoName} produced no changes.`,
    },
  });
}

export async function sweepPacketsMergedByAncestry(): Promise<MergedByAncestrySweepResult> {
  const candidates = buildCandidates();
  let merged = 0;
  let skipped = 0;

  // Drop parked entries for candidates that vanished (archived/merged out) so
  // the negative cache can't grow unbounded across sweeps.
  detectBackoff.prune(candidates.map(candidateKey));
  const now = Date.now();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    // A candidate whose detect() has been timing out is parked with growing
    // backoff — skip re-spawning its git pipeline until the window opens.
    if (detectBackoff.shouldSkip(key, now)) {
      skipped += 1;
      continue;
    }
    try {
      const evidence = await detectMergedByAncestry(candidate);
      detectBackoff.recordSuccess(key);
      if (!evidence) {
        skipped += 1;
        continue;
      }
      if (evidence.kind === 'no-changes') {
        await finishWithoutChanges(candidate, evidence);
      } else {
        await releasePacket(candidate, evidence);
      }
      merged += 1;
    } catch (error) {
      detectBackoff.recordFailure(key, now);
      skipped += 1;
      console.warn(
        `[merged-by-ancestry] skipped ${candidate.packet ? `packet ${candidate.packet.id}` : `lane ${candidate.laneId}`}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    scanned: candidates.length,
    merged,
    skipped,
  };
}
