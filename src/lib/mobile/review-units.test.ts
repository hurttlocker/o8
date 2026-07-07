import { describe, expect, it } from 'vitest';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { AgentSummary, WorkflowReviewSnapshot } from '@/lib/fleet/types';
import {
  buildMobileReviewUnits,
  shouldExposeWorkspaceReviewSnapshot,
  summarizeMobileReviewUnits,
  type MobileReviewUnitDiff,
} from '@/lib/mobile/review-units';

function session(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'agent-1',
    name: 'Codex',
    squadId: 'codex',
    runtime: 'codex',
    model: 'gpt-5',
    status: 'reviewing',
    currentTask: 'Review packet',
    workspace: '/repo/o8',
    branch: 'feature/mobile-review',
    sessionKey: 'codex-owned:test',
    approvalStatus: 'none',
    lastEventAt: 'now',
    context: { usedPercent: 12, trend: 'stable' },
    alerts: 0,
    runtimeSurface: {
      id: 'codex-owned:test',
      runtime: 'codex',
      kind: 'runtime-session',
      ownership: 'owned',
      title: 'Codex',
      cwd: '/repo/o8/.cortex-worktrees/packet-test',
      branch: 'feature/mobile-review',
      sourceLabel: 'Codex',
      capabilities: {
        attach: true,
        readTail: true,
        sendInput: true,
        interrupt: true,
        resize: true,
        diffContext: true,
        reviewContext: true,
      },
      reviewContext: {
        repoSlug: 'marquisehurtt/o8',
        branch: 'feature/mobile-review',
      },
    },
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'approval-1',
    projectId: null,
    source: 'runtime',
    runtime: 'codex',
    agent: 'Codex',
    sessionKey: 'codex-owned:test',
    title: 'Approve packet',
    description: 'Approve packet',
    summary: 'Approve packet',
    risk: 'medium',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    audit: [],
    fingerprint: 'approval-1',
    ...overrides,
  };
}

function diff(overrides: Partial<MobileReviewUnitDiff> = {}): MobileReviewUnitDiff {
  return {
    worktreePath: '/repo/o8/.cortex-worktrees/packet-test',
    baseBranch: 'main',
    headSha: 'abc123',
    changedFiles: [{ path: 'src/lib/mobile/inbox.ts', status: 'modified', additions: 4, deletions: 1 }],
    additions: 4,
    deletions: 1,
    ...overrides,
  };
}

function reviewSnapshot(overrides: Partial<WorkflowReviewSnapshot> = {}): WorkflowReviewSnapshot {
  return {
    generatedAt: '2026-07-07T00:00:00.000Z',
    repoSlug: '',
    repoPath: '',
    branch: 'unknown',
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
    diffStat: 'Working tree clean.',
    recentCommits: [],
    worktrees: [],
    pullRequests: [],
    activeIssues: [],
    ...overrides,
  };
}

describe('mobile review units', () => {
  it('promotes owned reviewing Codex sessions with real diffs to inspect-only units', async () => {
    const units = await buildMobileReviewUnits({
      sessions: [session()],
      pendingApprovals: [],
      collectSessionDiff: async () => diff(),
    });

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      id: 'review-session:codex-owned:test',
      authority: 'inspect_only',
      sessionKey: 'codex-owned:test',
      repoSlug: 'marquisehurtt/o8',
      branch: 'feature/mobile-review',
      fileCount: 1,
      additions: 4,
      deletions: 1,
      diffAvailable: true,
      actions: ['inspect', 'comment', 'steer', 'stop'],
    });
  });

  it('projects approval-backed reviews with approval authority and approval actions', async () => {
    const units = await buildMobileReviewUnits({
      sessions: [session()],
      pendingApprovals: [approval()],
      collectSessionDiff: async () => diff(),
    });

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      id: 'approval:approval-1',
      authority: 'approval_gate',
      approvalId: 'approval-1',
      fileCount: 1,
      actions: ['inspect', 'comment', 'approve', 'request_changes', 'deny'],
    });
  });

  it('summarizes concrete review units by authority', async () => {
    const units = await buildMobileReviewUnits({
      sessions: [session(), session({ sessionKey: 'codex-owned:other' })],
      pendingApprovals: [approval()],
      collectSessionDiff: async (target) => diff({
        changedFiles: [{ path: `${target.sessionKey}.ts`, status: 'modified' }],
        additions: 1,
        deletions: 0,
      }),
    });

    expect(summarizeMobileReviewUnits(units)).toEqual({
      reviewItems: 2,
      inspectOnlyReviews: 1,
    });
  });

  it('does not expose clean unknown workspace snapshots as review work', () => {
    expect(shouldExposeWorkspaceReviewSnapshot(reviewSnapshot())).toBe(false);
    expect(shouldExposeWorkspaceReviewSnapshot(reviewSnapshot({
      repoSlug: 'marquisehurtt/o8',
      repoPath: '/repo/o8',
      branch: 'feature/mobile-review',
      changedFiles: [{ path: 'src/lib/mobile/inbox.ts', status: 'modified' }],
      diffStat: '1 file changed',
    }))).toBe(true);
  });
});
