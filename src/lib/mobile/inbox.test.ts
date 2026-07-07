import { describe, expect, it } from 'vitest';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { AgentSummary } from '@/lib/fleet/types';
import { mobileSessionIdentity, toMobileFleetSession } from './inbox';

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  const sessionKey = overrides.sessionKey ?? 'codex-owned:one';
  return {
    id: sessionKey,
    name: 'Codex',
    squadId: 'codex',
    runtime: 'codex',
    model: 'gpt-5-codex',
    status: 'idle',
    currentTask: 'Waiting for input',
    workspace: '/repo/o8',
    branch: 'feature/mobile-fleet',
    sessionKey,
    approvalStatus: 'none',
    lastEventAt: 'just now',
    lastActivityAt: 1783396596568,
    context: {
      usedPercent: 0,
      trend: 'stable',
    },
    alerts: 0,
    runtimeSurface: {
      id: sessionKey,
      runtime: 'codex',
      kind: 'runtime-session',
      ownership: 'owned',
      title: 'Owned Codex',
      cwd: '/repo/o8/.cortex-worktrees/packet-one',
      branch: 'feature/mobile-fleet',
      sourceLabel: 'Owned Codex session',
      capabilities: {
        attach: true,
        readTail: true,
        sendInput: true,
        interrupt: false,
        resize: true,
        diffContext: true,
        reviewContext: true,
      },
      reviewContext: {
        repoSlug: 'marquisehurtt/o8',
        branch: 'feature/mobile-fleet',
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
    sessionKey: 'codex-owned:one',
    title: 'Review gate',
    description: 'Approve merge',
    summary: 'Approve merge',
    risk: 'medium',
    status: 'pending',
    createdAt: 1783396596568,
    updatedAt: 1783396596568,
    audit: [],
    fingerprint: 'approval-1',
    ...overrides,
  };
}

describe('mobile fleet inbox projection', () => {
  it('keys owned Codex sessions by live surface identity instead of repo and branch', () => {
    const first = agent({
      sessionKey: 'codex-owned:codex-owned-1783396596568-20bbab7b',
      runtimeSurface: {
        ...agent().runtimeSurface!,
        id: 'codex-owned:codex-owned-1783396596568-20bbab7b',
        cwd: '/repo/o8/.cortex-worktrees/packet-one',
      },
    });
    const second = agent({
      sessionKey: 'codex-owned:codex-owned-1783396572549-ef8fd2df',
      runtimeSurface: {
        ...agent().runtimeSurface!,
        id: 'codex-owned:codex-owned-1783396572549-ef8fd2df',
        cwd: '/repo/o8/.cortex-worktrees/packet-two',
      },
    });

    expect(first.runtimeSurface?.reviewContext?.repoSlug).toBe(second.runtimeSurface?.reviewContext?.repoSlug);
    expect(first.runtimeSurface?.reviewContext?.branch).toBe(second.runtimeSurface?.reviewContext?.branch);
    expect(mobileSessionIdentity(first)).toBe(first.sessionKey);
    expect(mobileSessionIdentity(second)).toBe(second.sessionKey);
    expect(new Set([mobileSessionIdentity(first), mobileSessionIdentity(second)]).size).toBe(2);
  });

  it('projects approval-backed review status and actions into canonical fleet rows', () => {
    const row = toMobileFleetSession(
      agent({
        status: 'running',
        tmuxSession: 'o8-worker-1',
      }),
      approval(),
    );

    expect(row.status).toBe('awaiting_review');
    expect(row.approvalId).toBe('approval-1');
    expect(row.reviewAuthority).toBe('approval_gate');
    expect(row.actions).toEqual(expect.arrayContaining(['inspect', 'open_terminal', 'resume', 'approve', 'request_changes']));
  });

  it('preserves lifecycle outcomes for non-approval workers', () => {
    const row = toMobileFleetSession(agent({
      status: 'idle',
      runtimeSurface: {
        ...agent().runtimeSurface!,
        lifecycle: {
          availability: 'ready-for-resume',
          lastOutcome: 'interrupted',
        },
      },
    }));

    expect(row.status).toBe('paused');
    expect(row.reviewAuthority).toBe('inspect_only');
    expect(row.sessionKey).toBe('codex-owned:one');
  });
});
