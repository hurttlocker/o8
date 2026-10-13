import { createApproval, getApproval } from '@/lib/approvals/store';
import { resolveApproval } from '@/lib/approvals/resolution';
import { museApprovalChoice, museRecord } from './protocol';

export async function requestMuseApproval(params: Record<string, unknown>, context: { sessionKey: string; repoPath: string; signal?: AbortSignal }, timeoutMs = 5 * 60_000): Promise<string | null> {
  const deny = museApprovalChoice(params, false);
  const subject = museRecord(params.subject);
  if (!deny || typeof params.approvalId !== 'string' || !['shell', 'command', 'network', 'fileAccess', 'fileWrite', 'write', 'tool', 'mcp'].includes(String(subject.kind))) return deny;
  // Persistent amendments, peer admission, protected writes and child requests need their own UI.
  if (params.protectedWrite === true || params.subagentOrigin || !museApprovalChoice(params, true) || context.signal?.aborted) return deny;
  const title = `Muse requests ${String(subject.command ?? subject.path ?? subject.host ?? params.toolName ?? 'an action').slice(0, 140)}`;
  let id: string | undefined;
  try {
    const approval = createApproval({ source: 'runtime', runtime: 'muse', agent: 'Muse Code', sessionKey: context.sessionKey,
      title, summary: title, description: 'Approve this action once. Persistent permission changes stay in Muse Code.',
      toolName: typeof params.toolName === 'string' ? params.toolName : 'muse_permission', editable: false,
      risk: 'high', args: { approvalId: params.approvalId, requirementId: params.currentRequirementId, subject },
      metadata: { Runtime: 'muse', Session: context.sessionKey, RepoPath: context.repoPath, Request: params.approvalId } });
    id = approval.id;
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && !context.signal?.aborted) {
      const current = getApproval(id);
      if (!current || current.status !== 'pending') return museApprovalChoice(params, current?.status === 'approved');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    resolveApproval(id, 'reject', 'system', 'Muse permission request expired or was cancelled.');
  } catch {
    if (id) { try { resolveApproval(id, 'reject', 'system', 'Muse approval could not be verified.'); } catch { /* Deny even if the store is unavailable. */ } }
  }
  return deny;
}
