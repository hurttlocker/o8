import type { ApprovalRecord } from '@/lib/approvals/types';
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
    const approval = approvals.find((candidate) => {
      const reviewedHeadSha = normalizeHeadSha(reviewedHeadForApproval(candidate));
      return candidate.toolName === 'orchestrator_review'
        && candidate.status === 'approved'
        && candidate.args?.requiresSecondPass === true
        && candidate.args?.secondPassAgreed !== true
        && reviewedHeadSha === currentHeadSha;
    });
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

export function buildBlindSecondPassPrompt(
  lane: Lane,
  diffSummary: BlindSecondPassDiffSummary,
  highRiskReasons: string[],
): string {
  const reasons = highRiskReasons.length > 0
    ? highRiskReasons.map((reason) => `- ${reason}`).join('\n')
    : '- high-risk classification returned no structured reason';
  return [
    `You are the blind, independent second-pass reviewer for lane "${lane.label}" (branch: ${lane.branch}).`,
    'Do not rely on any prior review, prior verdict, approval card, summary, or finding. Evaluate only the diff and protocol below.',
    '',
    `## High-risk reasons\n${reasons}`,
    '',
    diffSummary.summary,
    '',
    '## Required verification protocol',
    `Worktree: ${diffSummary.cwd}`,
    lane.packetId ? `Packet: ${lane.packetId}` : null,
    'SCOPE traces: for every changed file that writes or mutates state, cite `SCOPE: <file:line> partition=<repo|tenant|user|project|lane|packet|scope|slug|id|NONE>` and confirm the single intended destination.',
    'GUARD traces: for every new guard, condition, or early return, cite `GUARD: <file:line> fires-from=<file:line|INERT>`.',
    'COVERAGE checklist: enumerate each packet sub-requirement as `[x] <sub-requirement> - evidence <file:line|command output>` or `[ ] <sub-requirement> - gap <reason>`.',
    'EXECUTION-PATH TRACE: trace the actual call path the change runs under, not the one its name implies.',
    'You may agree only if every guard is live, every write is partitioned correctly, every sub-requirement is covered, and the execution path reaches the changed code.',
    '',
    'Do NOT call submit_review. Do NOT call lane_command. Do not stamp or merge anything yourself.',
    'End your output with EXACTLY one final line:',
    'SECOND_PASS_VERDICT: agree',
    'OR',
    'SECOND_PASS_VERDICT: disagree - <file:line> <reason>',
  ].filter((value): value is string => value !== null).join('\n');
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
