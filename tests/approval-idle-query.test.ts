import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApproval, getApproval, listApprovals, listUnsettledApprovalContinuations } from '@/lib/approvals/store';
import { claimApprovalResolution, finalizeApprovalContinuation } from '@/lib/approvals/resolution';
import { getSqlite } from '@/lib/db';
import type { ApprovalRecord } from '@/lib/approvals/types';

vi.mock('@/lib/repos/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/repos/projects')>(),
  getActiveProjectScopeForRepoSync: () => ({ projectId: 'query-project-a' }),
}));
vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

let sequence = 0;
function fixture(projectId: string | null = 'query-project-a', sessionKey = 'query-session-a', args?: ApprovalRecord['args']) {
  const approval = createApproval({
    projectId, source: 'test', runtime: 'codex', agent: 'worker', sessionKey,
    title: 'Query fixture', description: 'Query fixture', summary: `query-${++sequence}`,
    risk: 'low', args, continuation: { kind: 'lane', laneId: 'missing-query-lane', verb: 'merge' },
  });
  getSqlite().prepare('UPDATE approvals SET created_at = ? WHERE id = ?').run(Date.now() + sequence, approval.id);
  return approval;
}

describe('idle approval queries retain scope and history', () => {
  it('returns only unfinished continuations without decoding settled history', () => {
    const settled = fixture();
    const historyJson = JSON.stringify({ largeHistoryMarker: 'x'.repeat(1024 * 1024) });
    getSqlite().prepare('UPDATE approvals SET args_json = ? WHERE id = ?').run(historyJson, settled.id);
    const pending = fixture();
    claimApprovalResolution(pending.id, 'approve', 'desktop');
    const unknown = fixture();
    const claim = claimApprovalResolution(unknown.id, 'approve', 'desktop');
    finalizeApprovalContinuation(unknown.id, claim.claimId!, 'outcome_unknown', 'Receipt missing');
    const hidden = fixture('query-project-a', 'query-session-a', { approvalRoute: 'dispatcher', dispatcherSurface: 'worker' });
    claimApprovalResolution(hidden.id, 'approve', 'desktop');
    const invalid = fixture();
    getSqlite().prepare('UPDATE approvals SET resolution_json = ? WHERE id = ?').run('{broken', invalid.id);
    const parse = vi.spyOn(JSON, 'parse');

    const results = listUnsettledApprovalContinuations();

    expect(new Set(results.map((row) => row.id))).toEqual(new Set([pending.id, unknown.id]));
    expect(parse.mock.calls.some(([value]) => value === historyJson)).toBe(false);
    expect(getApproval(settled.id)?.id).toBe(settled.id);
    expect(getApproval(invalid.id)?.resolution).toBeUndefined();
  });

  it('preserves active-project defaults, explicit all-project scope, and session filters', () => {
    const a = fixture();
    const b = fixture('query-project-b');
    const otherSession = fixture('query-project-a', 'query-session-b');
    for (const row of [a, b, otherSession]) claimApprovalResolution(row.id, 'approve', 'desktop');
    const all = listApprovals({ status: 'all', projectId: null });
    for (const projectId of [undefined, null, 'query-project-a', 'query-project-b', ' ']) {
      for (const sessionKey of [undefined, 'query-session-a', 'query-session-b']) {
        const expectedProject = projectId === undefined ? 'query-project-a' : projectId?.trim() || null;
        const expected = all.filter((row) => (!expectedProject || row.projectId === expectedProject)
          && (!sessionKey || row.sessionKey === sessionKey));
        for (const status of ['all', 'pending', 'approved', 'rejected'] as const) {
          expect(listApprovals({ status, projectId, sessionKey }))
            .toEqual(expected.filter((row) => status === 'all' || row.status === status));
        }
        expect(listUnsettledApprovalContinuations({ projectId, sessionKey }))
          .toEqual(expected.filter((row) => ['pending', 'outcome_unknown'].includes(row.resolution?.continuationStatus ?? '')));
      }
    }
  });

  it('still expires stale pending rows through the normal query entry point', () => {
    const stale = fixture();
    getSqlite().prepare('UPDATE approvals SET created_at = ? WHERE id = ?')
      .run(Date.now() - 31 * 60_000, stale.id);
    listUnsettledApprovalContinuations();
    expect(getApproval(stale.id)?.status).toBe('rejected');
    expect(getApproval(stale.id)?.resolution?.actor).toBe('system');
  });
});
