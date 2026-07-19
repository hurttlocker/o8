import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const tempDirs: string[] = [];
const defaultsPath = join(process.env.CORTEX_IDE_DATA_DIR!, 'operator-defaults.json');

const { listApprovalsForContext, recordOrchestratorReview } = await import('@/lib/approvals/store');
const { dispatch } = await import('@/lib/lane/commands');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { getOperatorDefaults, updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getWorktreeManager } = await import('@/lib/worktree/launch');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', 'file.txt']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
}

async function createStandardLane(label: string, recordReview = true) {
  const root = mkdtempSync(join(os.tmpdir(), `o8-require-approval-${label}-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  const packetId = `pkt-require-approval-${label}-${Date.now()}`;
  const branch = `inline/require-approval-${label}-${Date.now()}`;
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);

  const manager = getWorktreeManager(repo);
  const worktree = await manager.create({
    agentType: 'codex',
    taskName: packetId,
    branchName: branch,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(worktree.path, 'file.txt'), 'base\nstandard change\n');
  commitAll(worktree.path, 'standard change');

  const reviewedHeadSha = git(worktree.path, ['rev-parse', 'HEAD']);
  const lane = createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
    label: `Standard diff ${label}`,
  });
  if (recordReview) {
    recordOrchestratorReview(packetId, {
      approved: true,
      findings: [],
      reviewer: 'codex',
      reviewedHeadSha,
      requiresSecondPass: false,
    });
  }

  return {
    lane,
    repo,
    reviewedHeadSha,
    baseHeadSha: git(repo, ['rev-parse', 'HEAD']),
  };
}

beforeEach(() => {
  rmSync(defaultsPath, { force: true });
});

afterEach(() => {
  rmSync(defaultsPath, { force: true });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('requireApproval merge governance through the real command path', () => {
  it('persists always, creates a lane-merge ApprovalRecord, and leaves the standard diff unmerged', async () => {
    await updateOperatorDefaults({ requireApproval: 'always' });
    const { lane, repo, baseHeadSha } = await createStandardLane('always');

    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });

    expect(result.ok).toBe(false);
    expect(result.approvalId).toBeTruthy();
    expect(getLane(lane.id)?.status).toBe('awaiting_input');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(baseHeadSha);
    const approval = listApprovalsForContext({
      packetId: lane.packetId ?? undefined,
      laneId: lane.id,
      sessionKey: lane.sessionKey ?? undefined,
    }).find((candidate) => candidate.id === result.approvalId);
    expect(approval).toMatchObject({
      status: 'pending',
      policyRuleId: 'lane-merge',
      continuation: {
        kind: 'lane',
        laneId: lane.id,
        verb: 'merge',
      },
    });
  }, 30_000);

  it('keeps explicit high-risk mode on today\'s standard-diff auto-merge behavior', async () => {
    expect((await getOperatorDefaults()).values.requireApproval).toBe('high-risk');
    await updateOperatorDefaults({ requireApproval: 'high-risk' });
    const { lane, repo, reviewedHeadSha } = await createStandardLane('high-risk');

    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });

    expect(result.ok).toBe(true);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(reviewedHeadSha);
    expect(listApprovalsForContext({ laneId: lane.id }).some((candidate) => (
      candidate.status === 'pending' && candidate.policyRuleId === 'lane-merge'
    ))).toBe(false);
  }, 30_000);

  it('lets never mode run a standard merge without a durable review card', async () => {
    await updateOperatorDefaults({ requireApproval: 'never' });
    const { lane, repo } = await createStandardLane('never', false);

    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });

    expect(result.ok).toBe(true);
    expect(git(repo, ['show', 'HEAD:file.txt'])).toContain('standard change');
    expect(listApprovalsForContext({ laneId: lane.id })).toHaveLength(0);
  }, 30_000);
});
