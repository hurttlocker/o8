import type {
  Lane,
  LaneCommandResult,
  LaneEventActor,
} from '@/lib/lane/types';
import type { ApprovalRisk } from '@/lib/approvals/types';
import { getSqlite } from '@/lib/db';
import { buildPolicyContext } from '@/lib/approvals/policies';
import { createApproval, recordApprovalAudit } from '@/lib/approvals/store';
import { FILE_SIZE_BLOCK_THRESHOLD_LINES, FILE_SIZE_WAIVERS } from '@/lib/orchestrator/dispatch';
import { buildConflictZonesFromDiffFiles, extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { parseGitDiff } from '@/lib/worktree/diff-parser';
import { setLaneStatus } from '@/lib/lane/registry';

async function getDiffForLane(lane: Pick<Lane, 'baseBranch' | 'worktreePath' | 'repoPath'>) {
  const cwd = lane.worktreePath || lane.repoPath;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const result = await execFileAsync('git', ['diff', `${lane.baseBranch}...HEAD`, '--no-color'], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    try {
      const fallback = await execFileAsync('git', ['diff', 'HEAD~1', '--no-color'], { cwd, maxBuffer: 10 * 1024 * 1024 });
      return fallback.stdout.trim();
    } catch {
      return '';
    }
  }
}

async function recordReviewLessonsForApproval(
  approvalId: string,
  lane: Lane,
  reviewSummary: string | undefined,
  files: ReturnType<typeof parseGitDiff>,
) {
  const summary = reviewSummary?.trim();
  if (!summary) {
    return;
  }

  const findings = extractReviewFindings(summary);
  const patterns = extractReviewPatterns(summary, findings);
  const conflictZones = buildConflictZonesFromDiffFiles(files);
  const approved = /\b(approve|approved|looks correct|ready to merge|ship it)\b/i.test(summary)
    ? true
    : /\b(request changes|reject|den(y|ied)|not ready|blocked)\b/i.test(summary)
      ? false
      : findings.length === 0;

  recordApprovalAudit(approvalId, 'orchestrator_review', 'orchestrator', summary, {
    findings: findings.length > 0 ? findings : undefined,
    reviewer: 'orchestrator',
    approved,
    patterns: patterns.length > 0 ? patterns : undefined,
    conflictZones: conflictZones.length > 0 ? conflictZones : undefined,
  });

  if (!lane.packetId || !lane.sessionKey) {
    return;
  }

  try {
    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    await capturePacketCompletionContext(lane.packetId, lane.sessionKey);
  } catch (error) {
    console.error(`[context-relay] Failed to refresh reviewed packet context for ${lane.packetId}:`, error);
  }
}

export function buildLanePolicyContext(
  lane: Pick<Lane, 'id' | 'repoPath'>,
  verb: 'create_pr' | 'merge',
  actor: LaneEventActor,
  opts?: { orchestratorReviewed?: boolean; fileSizeLimitExceeded?: boolean },
) {
  // Auto-approve when: (a) headless auto-review is active, or
  // (b) the orchestrator already reviewed and approved the packet.
  const autoReview = actor === 'orchestrator'
    && (isLaneAutoReviewInProgress(lane.id) || opts?.orchestratorReviewed === true);
  return buildPolicyContext('lane_command', {
    verb,
    laneId: lane.id,
    autoReview,
    fileSizeLimitExceeded: opts?.fileSizeLimitExceeded === true,
  }, {
    workspacePath: lane.repoPath,
  });
}

function isLaneAutoReviewInProgress(laneId: string) {
  try {
    const row = getSqlite()
      .prepare(`SELECT 1 FROM review_queue WHERE lane_id = ? AND status = 'in_progress' LIMIT 1`)
      .get(laneId);
    return Boolean(row);
  } catch {
    return false;
  }
}

export function formatOversizedFiles(files: Array<{ path: string; lineCount: number }>) {
  if (files.length === 0) {
    return 'none';
  }

  const labels = files.map((file) => `${file.path} (${file.lineCount}L)`);
  if (labels.length <= 4) {
    return labels.join(', ');
  }

  return `${labels.slice(0, 4).join(', ')} (+${labels.length - 4} more)`;
}

export async function getOversizedChangedFilesForLane(
  lane: Pick<Lane, 'baseBranch' | 'worktreePath'>,
) {
  if (!lane.worktreePath) {
    return [];
  }

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const result = await execFileAsync('git', ['diff', '--name-only', `${lane.baseBranch}...HEAD`], {
      cwd: lane.worktreePath,
      maxBuffer: 4 * 1024 * 1024,
    });
    const changedFiles = Array.from(new Set(
      result.stdout
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
    ));

    const lineCounts = await Promise.allSettled(
      changedFiles.map(async (filePath) => {
        const wcResult = await execFileAsync('wc', ['-l', filePath], {
          cwd: lane.worktreePath!,
          maxBuffer: 256 * 1024,
        });
        const match = wcResult.stdout.match(/^\s*(\d+)/);
        if (!match) {
          return null;
        }

        return {
          path: filePath,
          lineCount: Number.parseInt(match[1], 10),
        };
      }),
    );

    return lineCounts
      .flatMap((entry) => (entry.status === 'fulfilled' && entry.value ? [entry.value] : []))
      .filter((file) => !FILE_SIZE_WAIVERS.has(file.path) && file.lineCount > FILE_SIZE_BLOCK_THRESHOLD_LINES)
      .sort((left, right) => right.lineCount - left.lineCount || left.path.localeCompare(right.path));
  } catch {
    return [];
  }
}

export async function createLaneActionApproval(
  lane: Lane,
  actor: LaneEventActor,
  input: {
    verb: 'merge' | 'create_pr';
    commitMessage?: string;
    reviewSummary?: string;
    title: string;
    description: string;
    summary: string;
    risk: ApprovalRisk;
    policyRuleId: string;
    metadata?: Record<string, string>;
    note: string;
    gateResult?: import('@/lib/approvals/types').ApprovalGateResult;
    conflictReport?: import('@/lib/approvals/types').ApprovalConflictReport;
    strategy?: import('@/lib/approvals/types').MergeStrategy;
  },
): Promise<LaneCommandResult> {
  const rawDiff = await getDiffForLane(lane);
  const files = parseGitDiff(rawDiff);
  const approval = createApproval({
    source: 'runtime',
    runtime: lane.runtime,
    agent: lane.label || lane.branch,
    sessionKey: lane.sessionKey || `lane:${lane.id}`,
    title: input.title,
    description: input.description,
    summary: input.summary,
    diff: {
      path: 'multi-file',
      after: rawDiff || undefined,
      files,
    },
    gateResult: input.gateResult,
    conflictReport: input.conflictReport,
    risk: input.risk,
    policyRuleId: input.policyRuleId,
    metadata: {
      Lane: lane.id,
      Branch: lane.branch,
      Base: lane.baseBranch,
      Runtime: lane.runtime,
      ...(lane.packetId ? { Packet: lane.packetId } : {}),
      ...input.metadata,
    },
    continuation: {
      kind: 'lane',
      laneId: lane.id,
      verb: input.verb,
      commitMessage: input.commitMessage,
      strategy: input.strategy,
    },
  });
  await recordReviewLessonsForApproval(approval.id, lane, input.reviewSummary, files);
  setLaneStatus(lane.id, 'awaiting_input', actor, 'approval_required');
  void publishRealtimeMutation({
    mutation: {
      mutationId: `approval-create-${approval.id}`,
      source: 'desktop',
      action: 'approve',
      sessionKey: approval.sessionKey,
      surfaceId: approval.sessionKey,
      status: 'pending',
      note: `Approval required: ${approval.title}`,
      createdAt: new Date().toISOString(),
    },
    refreshTargets: ['global', 'mobileInbox'],
    sessionKeys: [approval.sessionKey],
    fresh: true,
  });
  return { ok: false, laneId: lane.id, note: input.note, approvalId: approval.id };
}
