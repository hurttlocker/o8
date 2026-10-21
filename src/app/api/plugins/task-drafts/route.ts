import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { readActiveIdentity } from '@/lib/github-broker/managed';
import { withTaskDraftAccountAdmission } from '@/lib/mcp/task-draft-account';
import { TaskDraftError } from '@/lib/mcp/task-draft-contract';
import { listTaskDrafts } from '@/lib/mcp/task-draft-store';
import { executionReceipt, readTaskExecution } from '@/lib/mcp/task-execution-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Local operator inspection only; there is deliberately no dispatch mutation. */
export async function GET(request: Request): Promise<Response> {
  const role = resolveRequestPrincipal(request);
  if (role !== 'operator') return NextResponse.json({ error: 'operator_required' }, { status: role === 'anonymous' ? 401 : 403 });
  try {
    const admission = { accountId: readActiveIdentity() ?? undefined, expiresAt: Infinity };
    return await withTaskDraftAccountAdmission(admission, undefined, (account) => {
      const drafts = listTaskDrafts(account.accountId).map((draft) => {
        let execution = null;
        let executionError = null;
        try {
          const record = readTaskExecution(draft);
          execution = record ? executionReceipt(record, true) : null;
        } catch { executionError = 'execution_uncertain'; }
        return {
          taskId: draft.taskId, createdAt: draft.createdAt, state: draft.state, executionEnabled: false,
          sessionCurrent: draft.account.epoch === account.epoch, policy: draft.policy,
          contract: draft.contract, revision: draft.snapshot.revision, rulesDigest: draft.snapshot.rulesDigest,
          contractHash: draft.contractHash, execution, executionError,
        };
      });
      return NextResponse.json({ ok: true, accountId: account.accountId, drafts }, { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof TaskDraftError ? error.code : 'draft_store_unavailable' },
      { status: error instanceof TaskDraftError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
