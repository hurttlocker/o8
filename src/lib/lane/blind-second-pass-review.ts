import type { ApprovalRecord } from '@/lib/approvals/types';
import type { PacketTaskContract } from '@/lib/orchestrator/types';
import { buildBlindSecondPassPromptV1 } from '@/lib/prompts/v1';
import { recordLaneEvent } from './events';
import { enqueueLaneReview, surfaceReviewQueueBlocker } from './review-queue';
import type { Lane } from './types';

export interface BlindSecondPassDiffSummary {
  summary: string;
  changedFiles: string[];
  addedLines: string[];
  cwd: string;
}

export type SecondPassVerdict =
  | { verdict: 'agree' }
  | { verdict: 'disagree'; finding: string }
  | { verdict: 'inconclusive'; reason: string };

function reviewedHeadForApproval(approval: ApprovalRecord): string | undefined {
  const argsHead = approval.args?.reviewedHeadSha;
  return typeof argsHead === 'string' ? argsHead : approval.metadata?.['Reviewed HEAD'];
}

function reviewVerdictTimestamp(approval: ApprovalRecord): number {
  for (let index = approval.audit.length - 1; index >= 0; index -= 1) {
    const event = approval.audit[index];
    if (event?.type === 'orchestrator_review') return event.timestamp;
  }
  return approval.createdAt;
}

function compareReviewVerdictRecency(left: ApprovalRecord, right: ApprovalRecord): number {
  return reviewVerdictTimestamp(right) - reviewVerdictTimestamp(left)
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id);
}

export async function findPendingSecondPassApproval(lane: Lane) {
  try {
    const [{ listApprovalsForContext }, { normalizeHeadSha, readHeadSha }] = await Promise.all([
      import('@/lib/approvals/store'),
      import('@/lib/lane/head-sha-lock'),
    ]);
    const currentHeadSha = normalizeHeadSha(await readHeadSha(lane.worktreePath || lane.repoPath));
    if (!currentHeadSha) return null;
    const approvals = listApprovalsForContext({
      packetId: lane.packetId ?? undefined,
      laneId: lane.id,
      sessionKey: lane.sessionKey ?? undefined,
      projectId: null,
    });
    const latestVerdict = approvals.filter((candidate) => {
      const reviewedHeadSha = normalizeHeadSha(reviewedHeadForApproval(candidate));
      return candidate.toolName === 'orchestrator_review'
        && candidate.args?.reviewSuperseded !== true
        && reviewedHeadSha === currentHeadSha;
    }).sort(compareReviewVerdictRecency)[0];
    const approval = latestVerdict?.status === 'approved'
      && latestVerdict.args?.approved === true
      && latestVerdict.args?.requiresSecondPass === true
      && latestVerdict.args?.secondPassAgreed !== true
      ? latestVerdict
      : undefined;
    const reviewedHeadSha = approval ? normalizeHeadSha(reviewedHeadForApproval(approval)) : undefined;
    const alreadyBlocked = approval && reviewedHeadSha && approvals.some((candidate) => (
      candidate.toolName === 'orchestrator_second_pass'
      && candidate.args?.approvalId === approval.id
      && candidate.args?.reviewedHeadSha === reviewedHeadSha
    ));
    if (alreadyBlocked) return null;
    return approval && reviewedHeadSha ? { approval, reviewedHeadSha } : null;
  } catch (error) {
    console.warn(`[auto-review] Failed to find pending second-pass approval for lane ${lane.id}:`, error);
    return null;
  }
}

export async function rearmPendingSecondPassApproval(
  lane: Lane,
  expected?: { approvalId: string; reviewedHeadSha?: string },
): Promise<{
  scheduled: boolean;
  reviewedHeadSha?: string;
  reason?: string;
}> {
  const pending = await findPendingSecondPassApproval(lane);
  if (!pending) {
    if (!expected) return { scheduled: false };
    const reason = `Approval ${expected.approvalId} requires blind second-pass review${expected.reviewedHeadSha ? ` at HEAD ${expected.reviewedHeadSha}` : ''}, but no schedulable approval was found.`;
    surfaceReviewQueueBlocker({
      laneId: lane.id,
      reviewId: `second-pass:${expected.approvalId}`,
      reason,
      attempts: 0,
    });
    return { scheduled: false, reviewedHeadSha: expected.reviewedHeadSha, reason };
  }

  if (lane.status !== 'reviewing') {
    const reason = `Blind second-pass review for HEAD ${pending.reviewedHeadSha} cannot run while lane ${lane.id} is ${lane.status}.`;
    surfaceReviewQueueBlocker({
      laneId: lane.id,
      reviewId: `second-pass:${pending.approval.id}`,
      reason,
      attempts: 0,
    });
    return { scheduled: false, reviewedHeadSha: pending.reviewedHeadSha, reason };
  }

  try {
    const queued = enqueueLaneReview(lane, { afterInProgress: true });
    recordLaneEvent(lane.id, 'second_pass_rearmed', 'system', {
      packetId: lane.packetId,
      approvalId: pending.approval.id,
      reviewedHeadSha: pending.reviewedHeadSha,
      reviewId: queued.reviewId,
      queued: queued.queued,
    });
    return { scheduled: true, reviewedHeadSha: pending.reviewedHeadSha };
  } catch (error) {
    const reason = `Blind second-pass review for HEAD ${pending.reviewedHeadSha} could not be queued: ${error instanceof Error ? error.message : String(error)}`;
    surfaceReviewQueueBlocker({
      laneId: lane.id,
      reviewId: `second-pass:${pending.approval.id}`,
      reason,
      attempts: 0,
    });
    return { scheduled: false, reviewedHeadSha: pending.reviewedHeadSha, reason };
  }
}

export function buildBlindSecondPassPrompt(
  lane: Lane,
  diffSummary: BlindSecondPassDiffSummary,
  highRiskReasons: string[],
  taskContract?: PacketTaskContract | null,
  taskContractRequired = false,
): string {
  return buildBlindSecondPassPromptV1({
    laneLabel: lane.label,
    branch: lane.branch,
    packetId: lane.packetId,
    diffSummary: diffSummary.summary,
    cwd: diffSummary.cwd,
    highRiskReasons,
    taskContract,
    taskContractRequired,
  });
}

export function parseSecondPassVerdict(rawText: string): SecondPassVerdict {
  let text = rawText.trim();
  if (!text) return { verdict: 'inconclusive', reason: 'empty second-pass response' };
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const result = parsed.result && typeof parsed.result === 'object'
        ? parsed.result as Record<string, unknown>
        : parsed;
      const payloadText = Array.isArray(result.payloads)
        ? result.payloads.map((payload) => (
          payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string'
            ? (payload as { text: string }).text
            : ''
        )).filter(Boolean).join('\n\n')
        : '';
      const meta = result.meta && typeof result.meta === 'object' ? result.meta as Record<string, unknown> : {};
      text = payloadText
        || (typeof meta.finalAssistantVisibleText === 'string' ? meta.finalAssistantVisibleText : '')
        || (typeof result.text === 'string' ? result.text : '');
      if (!text.trim()) return { verdict: 'inconclusive', reason: 'JSON second-pass response had no assistant text' };
    } catch {
      return { verdict: 'inconclusive', reason: 'unparseable JSON second-pass response' };
    }
  }
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const finalLine = lines[lines.length - 1] ?? '';
  if (/^SECOND_PASS_VERDICT:\s*agree$/i.test(finalLine)) return { verdict: 'agree' };
  const disagree = finalLine.match(/^SECOND_PASS_VERDICT:\s*disagree\s*-\s+(.+)$/i);
  if (!disagree) return { verdict: 'inconclusive', reason: `missing structured SECOND_PASS_VERDICT tail: ${finalLine.slice(0, 200) || '(none)'}` };
  const finding = disagree[1].trim();
  if (!/\b[\w./@-]+:\d+\b/.test(finding)) {
    return { verdict: 'inconclusive', reason: `disagree lacked a concrete file:line citation: ${finding.slice(0, 200)}` };
  }
  return { verdict: 'disagree', finding };
}
