import type { ApprovalRecord } from '@/lib/approvals/types';
import { buildBlindSecondPassPromptV1 } from '@/lib/prompts/v1';
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
  return buildBlindSecondPassPromptV1({
    laneLabel: lane.label,
    branch: lane.branch,
    packetId: lane.packetId,
    diffSummary: diffSummary.summary,
    cwd: diffSummary.cwd,
    highRiskReasons,
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
