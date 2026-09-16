/**
 * #2254 — a durable approved review covers the reviewed commit, and only it.
 *
 * The review pins a HEAD SHA. Edits left in the worktree after that review
 * (tracked or untracked) are not part of the reviewed commit, so they must not
 * count as covered, and the merge must not auto-commit them into the approved
 * publication. Drives the real lane merge command against persisted approval
 * rows and a real git worktree.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Storage admission reads the host volume; keep the fixture independent of
// the machine's free space.
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const tempDirs: string[] = [];
const defaultsPath = join(process.env.CORTEX_IDE_DATA_DIR!, 'operator-defaults.json');

const { listApprovalsForContext, recordOrchestratorReview } = await import('@/lib/approvals/store');
const { dispatch } = await import('@/lib/lane/commands');
const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { createLane } = await import('@/lib/lane/registry');
const { getWorktreeManager } = await import('@/lib/worktree/launch');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
}

async function createReviewedLane(label: string) {
  const root = mkdtempSync(join(os.tmpdir(), `o8-durable-dirty-${label}-`));
  tempDirs.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  const packetId = `pkt-durable-dirty-${label}-${Date.now()}`;
  const branch = `inline/durable-dirty-${label}-${Date.now()}`;

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  writeFileSync(join(repo, 'notes.txt'), 'notes\n');
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);

  const worktree = await getWorktreeManager(repo).create({
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
  writeFileSync(join(worktree.path, 'file.txt'), 'base\nreviewed change\n');
  commitAll(worktree.path, 'reviewed change');
  const reviewedHeadSha = git(worktree.path, ['rev-parse', 'HEAD']);

  const lane = createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
    label: `Durable dirty ${label}`,
  });
  recordOrchestratorReview(packetId, {
    approved: true,
    findings: [],
    reviewer: 'codex',
    reviewedHeadSha,
    requiresSecondPass: false,
  });

  return { lane, repo, worktreePath: worktree.path, reviewedHeadSha, baseHeadSha: git(repo, ['rev-parse', 'HEAD']) };
}

beforeEach(() => {
  rmSync(defaultsPath, { force: true });
});

afterEach(() => {
  rmSync(defaultsPath, { force: true });
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable review coverage is the reviewed commit only (#2254)', () => {
  it('refuses an agent merge that would carry edits made after the reviewed HEAD, naming them', async () => {
    const fixture = await createReviewedLane('uncovered');
    writeFileSync(join(fixture.worktreePath, 'notes.txt'), 'notes\nunreviewed edit\n');
    writeFileSync(join(fixture.worktreePath, 'extra.txt'), 'unreviewed file\n');

    const assessment = await assessDurableApprovedReview(fixture.lane);
    expect(assessment.approved).toBe(false);
    expect(assessment.reason).toContain('notes.txt');
    expect(assessment.reason).toContain('extra.txt');

    const result = await dispatch({
      verb: 'merge',
      laneId: fixture.lane.id,
      actor: 'orchestrator',
      commitMessage: 'fix: would sweep the unreviewed edits in',
    });

    expect(result.ok).toBe(false);
    expect(result.approvalId).toBeTruthy();
    expect(result.note).toContain('notes.txt');
    expect(result.note).toContain('extra.txt');
    const approval = listApprovalsForContext({ laneId: fixture.lane.id })
      .find((candidate) => candidate.id === result.approvalId);
    expect(approval).toMatchObject({ status: 'pending', policyRuleId: 'lane-merge' });
    expect(approval?.description).toContain('notes.txt');

    // Nothing was published, and the extra edits were not committed.
    expect(git(fixture.repo, ['rev-parse', 'HEAD'])).toBe(fixture.baseHeadSha);
    expect(git(fixture.repo, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0]).toBe(fixture.baseHeadSha);
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.reviewedHeadSha);
    expect(git(fixture.worktreePath, ['status', '--porcelain', '-uall'])).toContain('notes.txt');
  }, 60_000);

  it('still merges the reviewed commit when the worktree is clean', async () => {
    const fixture = await createReviewedLane('clean');

    const result = await dispatch({
      verb: 'merge',
      laneId: fixture.lane.id,
      actor: 'orchestrator',
      commitMessage: 'fix: reviewed change',
    });

    expect(result.ok).toBe(true);
    expect(git(fixture.repo, ['rev-parse', 'HEAD^{tree}'])).toBe(git(fixture.repo, ['rev-parse', `${fixture.reviewedHeadSha}^{tree}`]));
  }, 60_000);
});
