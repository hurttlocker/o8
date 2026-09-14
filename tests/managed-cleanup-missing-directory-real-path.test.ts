import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';

import type { CleanupOptions, WorktreeMetaEntry } from '@/lib/worktree/types';

const fsFault = vi.hoisted(() => ({ path: null as string | null, code: null as string | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const nodePath = await import('node:path');
  const actualLstat = actual.lstat as unknown as (
    target: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  const actualAccess = actual.access as unknown as (
    target: unknown,
    mode?: unknown,
  ) => Promise<void>;
  const actualStat = actual.stat as unknown as (
    target: unknown,
    options?: unknown,
  ) => Promise<unknown>;
  const throwIfFaulted = (target: unknown): void => {
    if (fsFault.path && fsFault.code
      && nodePath.resolve(String(target)) === nodePath.resolve(fsFault.path)) {
      const error = new Error(
        `injected ${fsFault.code} for ${String(target)}`,
      ) as NodeJS.ErrnoException;
      error.code = fsFault.code;
      throw error;
    }
  };
  return {
    ...actual,
    lstat: async (target: unknown, options?: unknown) => {
      throwIfFaulted(target);
      return actualLstat(target, options);
    },
    access: async (target: unknown, mode?: unknown) => {
      throwIfFaulted(target);
      return actualAccess(target, mode);
    },
    stat: async (target: unknown, options?: unknown) => {
      throwIfFaulted(target);
      return actualStat(target, options);
    },
  };
});

const priorWorktreeRoot = process.env.O8_WORKTREE_ROOT;
const roots: string[] = [];

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (priorWorktreeRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
  else process.env.O8_WORKTREE_ROOT = priorWorktreeRoot;
});

const cleanupOptions = {
  force: true,
  deleteBranch: true,
  overrideLiveGuard: true,
} as const;

function makeRepo(label: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `o8-${label}-`));
  roots.push(root);
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
  execFileSync('git', [
    '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',
    'commit', '-q', '-m', 'base',
  ], { cwd: repo });
  return realpathSync(repo);
}

async function setupTrackedWorkspace(
  label: string,
  options: { gitWorktree?: boolean; dependencyImage?: boolean } = {},
) {
  const repoPath = makeRepo(label);
  const worktreeRoot = mkdtempSync(path.join(os.tmpdir(), `o8-${label}-root-`));
  roots.push(worktreeRoot);
  process.env.O8_WORKTREE_ROOT = worktreeRoot;
  const { addRepo } = await import('@/lib/repos/registry');
  const { createLane } = await import('@/lib/lane/registry');
  const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
  const repo = await addRepo(repoPath);
  const layout = resolveWorktreeRootLayout(repoPath);
  mkdirSync(layout.primaryBase, { recursive: true });
  const parentIdentity = await captureWorktreeMaterializationIdentity(layout.primaryBase);
  const id = `packet-${label}`;
  const worktreePath = path.join(layout.primaryBase, id);
  const branch = `inline/${label}`;
  if (options.gitWorktree) {
    execFileSync('git', ['worktree', 'add', '-q', '-b', branch, worktreePath, 'main'], { cwd: repoPath });
  } else {
    mkdirSync(worktreePath);
  }
  writeFileSync(path.join(worktreePath, 'tracked.txt'), 'owned\n');
  const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
  const saveEntry = async (
    entryId: string,
    identity: Awaited<ReturnType<typeof captureWorktreeMaterializationIdentity>>,
    extra: Partial<WorktreeMetaEntry> = {},
  ) => withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(entryId, {
    id: entryId,
    agentType: 'codex',
    baseBranch: 'main',
    createdAt: Date.now(),
    claudeManaged: false,
    taskName: entryId,
    branchName: entryId === id ? branch : `inline/${entryId}`,
    status: 'ready',
    isolationKind: 'git-worktree',
    materializationIdentity: identity,
    materializationParentIdentity: parentIdentity,
    ...extra,
  }));
  const dependencyExtra: Partial<WorktreeMetaEntry> = options.dependencyImage ? {
    dependencyRecipeKey: 'a'.repeat(64),
    dependencyMaterialization: {
      mode: 'image',
      status: 'mounted',
      installCommand: 'npm ci',
      recipeKey: 'a'.repeat(64),
      leaseId: 'lease-test',
      generation: 'generation-test',
      workspaceDevice: materializationIdentity.device,
      workspaceInode: materializationIdentity.inode,
    },
  } : {};
  await saveEntry(id, materializationIdentity, dependencyExtra);
  const unrelatedId = `packet-unrelated-${label}`;
  const unrelatedPath = path.join(layout.primaryBase, unrelatedId);
  mkdirSync(unrelatedPath);
  writeFileSync(path.join(unrelatedPath, 'keep.txt'), 'keep\n');
  await saveEntry(
    unrelatedId,
    await captureWorktreeMaterializationIdentity(unrelatedPath),
  );
  const lane = createLane({
    repoPath,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId: id,
    worktreePath,
    ownership: 'managed',
    actor: 'orchestrator',
  });
  return {
    repoPath,
    repo,
    id,
    worktreePath,
    branch,
    lane,
    layout,
    parentIdentity,
    materializationIdentity,
    unrelatedId,
    unrelatedPath,
  };
}

async function seedSnapshot(fixture: Awaited<ReturnType<typeof setupTrackedWorkspace>>) {
  const { readImmutableWorkspaceTruth, ensureWorkspaceRecoveryRef } = await import('@/lib/workspace/hibernator');
  const { createWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
  const truth = await readImmutableWorkspaceTruth(fixture.repo, fixture.lane);
  await ensureWorkspaceRecoveryRef(fixture.repoPath, fixture.worktreePath, truth);
  createWorkspaceSnapshot({
    repositoryUuid: fixture.repo.id,
    packetId: fixture.id,
    laneId: fixture.lane.id,
    originalPath: fixture.worktreePath,
    branch: truth.branch,
    baseCommit: truth.baseCommit,
    headCommit: truth.headCommit,
    treeSha: truth.treeSha,
    recoveryRef: truth.recoveryRef,
    diffFingerprint: truth.diffFingerprint,
    sessionIdentities: [],
    creationId: `${fixture.id}-created`,
  });
}

async function readDurableEntry(repoPath: string, id: string) {
  const { readWorktreeMetaSnapshot } = await import('@/lib/worktree/metadata-store');
  return (await readWorktreeMetaSnapshot(repoPath))[id];
}

async function cleanupOutcome(
  repoPath: string,
  id: string,
  options: CleanupOptions = cleanupOptions,
): Promise<'retired' | 'refused' | 'rejected'> {
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  try {
    return (await new WorktreeManager(repoPath).cleanup(id, options)) ? 'retired' : 'refused';
  } catch {
    return 'rejected';
  }
}

it('converges a confirmed-missing tracked directory once, then stays silent', async () => {
  const fixture = await setupTrackedWorkspace(`absent-${Date.now()}`);
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
  const { readExactWorkspaceClaim } = await import('@/lib/workspace/exact-workspace-claim-state');
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  expect(existsSync(fixture.worktreePath)).toBe(false);

  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const manager = new WorktreeManager(fixture.repoPath);
    const first = await manager.cleanup(fixture.id, cleanupOptions);
    const metadataAfterFirst = await readDurableEntry(fixture.repoPath, fixture.id);
    const snapshotAfterFirst = getWorkspaceSnapshot(fixture.repo.id, fixture.id);
    const claimAfterFirst = readExactWorkspaceClaim('managed-retirement', fixture.repoPath, fixture.id);
    const firstRefusals = errorSpy.mock.calls.filter((args) => (
      String(args[0]).includes('REFUSED')
      && args.some((argument) => String(argument).includes(fixture.id))
    ));
    const { getLaneEvents } = await import('@/lib/lane/registry');
    const eventsFor = (verb: string) => getLaneEvents(fixture.lane.id)
      .filter((event) => event.verb === verb);
    const firstAbsence = eventsFor('workspace_absence_observed');
    const firstCompletion = eventsFor('workspace_retirement_confirmed');

    errorSpy.mockClear();
    warnSpy.mockClear();
    logSpy.mockClear();
    const second = await manager.cleanup(fixture.id, cleanupOptions);
    const secondLogs = [
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...logSpy.mock.calls,
    ].filter((args) => args.some((argument) => String(argument).includes(fixture.id)));

    expect(first).toBe(true);
    expect(metadataAfterFirst).toBeUndefined();
    expect(snapshotAfterFirst).toBeNull();
    expect(claimAfterFirst).toBeNull();
    expect(firstRefusals).toHaveLength(0);
    expect(firstAbsence).toHaveLength(1);
    expect(firstAbsence[0]?.payload).toMatchObject({
      reason: 'confirmed-missing-directory',
      action: 'cleanup',
    });
    expect(firstCompletion).toHaveLength(1);
    expect(await readDurableEntry(fixture.repoPath, fixture.unrelatedId)).toBeDefined();
    expect(existsSync(fixture.unrelatedPath)).toBe(true);
    expect(second).toBe(true);
    expect(secondLogs).toHaveLength(0);
    expect(eventsFor('workspace_absence_observed')).toHaveLength(1);
    expect(eventsFor('workspace_retirement_confirmed')).toHaveLength(1);
  } finally {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  }
}, 60_000);

it.each(['EACCES', 'EIO', 'EPERM'] as const)(
  'preserves durable metadata when the child probe fails with %s',
  async (code) => {
    const fixture = await setupTrackedWorkspace(`probe-${code.toLowerCase()}-${Date.now()}`);
    const { closeDb } = await import('@/lib/db');
    rmSync(fixture.worktreePath, { recursive: true, force: true });
    fsFault.path = fixture.materializationIdentity.canonicalPath;
    fsFault.code = code;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await cleanupOutcome(fixture.repoPath, fixture.id);
      const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
      const { readExactWorkspaceClaim } = await import('@/lib/workspace/exact-workspace-claim-state');

      expect(outcome).not.toBe('retired');
      expect(await readDurableEntry(fixture.repoPath, fixture.id)).toBeDefined();
      expect(getWorkspaceSnapshot(fixture.repo.id, fixture.id)).toBeNull();
      expect(readExactWorkspaceClaim('managed-retirement', fixture.repoPath, fixture.id)).toBeNull();
      expect(await readDurableEntry(fixture.repoPath, fixture.unrelatedId)).toBeDefined();
    } finally {
      fsFault.path = null;
      fsFault.code = null;
      errorSpy.mockRestore();
      closeDb();
    }
  },
  60_000,
);

it('preserves durable metadata when the child was replaced by another directory', async () => {
  const fixture = await setupTrackedWorkspace(`swapped-${Date.now()}`);
  const retained = `${fixture.worktreePath}-retained`;
  renameSync(fixture.worktreePath, retained);
  mkdirSync(fixture.worktreePath);
  writeFileSync(path.join(fixture.worktreePath, 'replacement.txt'), 'replacement\n');
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const outcome = await cleanupOutcome(fixture.repoPath, fixture.id);

    expect(outcome).not.toBe('retired');
    expect(await readDurableEntry(fixture.repoPath, fixture.id)).toBeDefined();
    expect(readFileSync(path.join(fixture.worktreePath, 'replacement.txt'), 'utf8'))
      .toBe('replacement\n');
    expect(readFileSync(path.join(retained, 'tracked.txt'), 'utf8')).toBe('owned\n');
    expect(existsSync(fixture.unrelatedPath)).toBe(true);
  } finally {
    errorSpy.mockRestore();
  }
}, 60_000);

it.each(['EACCES', 'EIO'] as const)(
  'preserves durable metadata when the parent probe fails with %s',
  async (code) => {
    const fixture = await setupTrackedWorkspace(`parent-${code.toLowerCase()}-${Date.now()}`);
    const { closeDb } = await import('@/lib/db');
    rmSync(fixture.worktreePath, { recursive: true, force: true });
    fsFault.path = fixture.parentIdentity.canonicalPath;
    fsFault.code = code;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await cleanupOutcome(fixture.repoPath, fixture.id);
      const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
      const { readExactWorkspaceClaim } = await import('@/lib/workspace/exact-workspace-claim-state');

      expect(outcome).not.toBe('retired');
      expect(await readDurableEntry(fixture.repoPath, fixture.id)).toBeDefined();
      expect(getWorkspaceSnapshot(fixture.repo.id, fixture.id)).toBeNull();
      expect(readExactWorkspaceClaim('managed-retirement', fixture.repoPath, fixture.id)).toBeNull();
    } finally {
      fsFault.path = null;
      fsFault.code = null;
      errorSpy.mockRestore();
      closeDb();
    }
  },
  60_000,
);

it('preserves durable metadata when the parent directory was replaced', async () => {
  const fixture = await setupTrackedWorkspace(`parent-swapped-${Date.now()}`);
  const { closeDb } = await import('@/lib/db');
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  const retainedBase = `${fixture.layout.primaryBase}-retained`;
  renameSync(fixture.layout.primaryBase, retainedBase);
  mkdirSync(fixture.layout.primaryBase);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const outcome = await cleanupOutcome(fixture.repoPath, fixture.id);
    const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');

    expect(outcome).not.toBe('retired');
    expect(await readDurableEntry(fixture.repoPath, fixture.id)).toBeDefined();
    expect(getWorkspaceSnapshot(fixture.repo.id, fixture.id)).toBeNull();
  } finally {
    errorSpy.mockRestore();
    closeDb();
  }
}, 60_000);

it('preserves durable metadata when the parent directory is missing', async () => {
  const fixture = await setupTrackedWorkspace(`parent-missing-${Date.now()}`);
  const { closeDb } = await import('@/lib/db');
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  rmSync(fixture.layout.primaryBase, { recursive: true, force: true });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const outcome = await cleanupOutcome(fixture.repoPath, fixture.id);
    const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');

    expect(outcome).not.toBe('retired');
    expect(await readDurableEntry(fixture.repoPath, fixture.id)).toBeDefined();
    expect(getWorkspaceSnapshot(fixture.repo.id, fixture.id)).toBeNull();
  } finally {
    errorSpy.mockRestore();
    closeDb();
  }
}, 60_000);

it('retires an existing snapshot with its durable cleanup reason and removes only that entry', async () => {
  const fixture = await setupTrackedWorkspace(`snapshot-${Date.now()}`, { gitWorktree: true });
  const { closeDb } = await import('@/lib/db');
  await seedSnapshot(fixture);
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { getWorkspaceSnapshot, listWorkspaceSnapshotTransitions } = await import('@/lib/worktree/snapshot-state');
    const before = getWorkspaceSnapshot(fixture.repo.id, fixture.id);
    expect(before?.state).toBe('materialized');

    const outcome = await cleanupOutcome(fixture.repoPath, fixture.id);
    const after = getWorkspaceSnapshot(fixture.repo.id, fixture.id);
    const retiredTransition = listWorkspaceSnapshotTransitions(fixture.repo.id, fixture.id)
      .findLast((entry) => entry.toState === 'retired');

    expect(outcome).toBe('retired');
    expect(after).toMatchObject({
      state: 'retired',
      snapshotGeneration: before!.snapshotGeneration,
      version: before!.version + 2,
    });
    expect(retiredTransition?.receipt?.terminalAction).toBe('cleanup');
    expect(await readDurableEntry(fixture.repoPath, fixture.id)).toBeUndefined();
    expect(await readDurableEntry(fixture.repoPath, fixture.unrelatedId)).toBeDefined();
    expect(existsSync(fixture.unrelatedPath)).toBe(true);
  } finally {
    errorSpy.mockRestore();
    closeDb();
  }
}, 60_000);

it('preserves a conflicting durable retirement action instead of bypassing the state machine', async () => {
  const fixture = await setupTrackedWorkspace(`conflict-${Date.now()}`, { gitWorktree: true });
  const { closeDb } = await import('@/lib/db');
  await seedSnapshot(fixture);
  const { beginWorkspaceMaterializationRetirement, getWorkspaceRetirementAction } = await import(
    '@/lib/workspace/workspace-materialization-retirement'
  );
  beginWorkspaceMaterializationRetirement(fixture.worktreePath, 'discard');
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
    const outcome = await cleanupOutcome(fixture.repoPath, fixture.id, {
      ...cleanupOptions,
      workspaceRetirementAction: 'cleanup',
    });

    expect(outcome).not.toBe('retired');
    expect(getWorkspaceSnapshot(fixture.repo.id, fixture.id)?.state).toBe('retiring');
    expect(getWorkspaceRetirementAction(fixture.worktreePath)).toBe('discard');
    expect(await readDurableEntry(fixture.repoPath, fixture.id)).toBeDefined();
    expect(await readDurableEntry(fixture.repoPath, fixture.unrelatedId)).toBeDefined();
  } finally {
    errorSpy.mockRestore();
    closeDb();
  }
}, 60_000);

it.each(['discard', 'merge', 'pr'] as const)(
  'refuses a confirmed-missing workspace retired as %s without preexisting snapshot evidence',
  async (action) => {
    const fixture = await setupTrackedWorkspace(`action-${action}-${Date.now()}`);
    const { closeDb } = await import('@/lib/db');
    rmSync(fixture.worktreePath, { recursive: true, force: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await cleanupOutcome(fixture.repoPath, fixture.id, {
        ...cleanupOptions,
        workspaceRetirementAction: action,
      });
      const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
      const { getLaneEvents } = await import('@/lib/lane/registry');

      expect(outcome).not.toBe('retired');
      expect(await readDurableEntry(fixture.repoPath, fixture.id)).toBeDefined();
      expect(getWorkspaceSnapshot(fixture.repo.id, fixture.id)).toBeNull();
      expect(getLaneEvents(fixture.lane.id).filter(
        (event) => event.verb === 'workspace_retirement_confirmed',
      )).toHaveLength(0);
      expect(await readDurableEntry(fixture.repoPath, fixture.unrelatedId)).toBeDefined();
    } finally {
      errorSpy.mockRestore();
      closeDb();
    }
  },
  60_000,
);

it('replays a legitimate non-cleanup retirement from preexisting verified snapshot evidence', async () => {
  const fixture = await setupTrackedWorkspace(`replay-${Date.now()}`, { gitWorktree: true });
  const { closeDb } = await import('@/lib/db');
  await seedSnapshot(fixture);
  const { beginWorkspaceMaterializationRetirement } = await import(
    '@/lib/workspace/workspace-materialization-retirement'
  );
  beginWorkspaceMaterializationRetirement(fixture.worktreePath, 'discard');
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const outcome = await cleanupOutcome(fixture.repoPath, fixture.id, {
      ...cleanupOptions,
      workspaceRetirementAction: 'discard',
    });
    const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');

    expect(outcome).toBe('retired');
    expect(getWorkspaceSnapshot(fixture.repo.id, fixture.id)?.state).toBe('retired');
    expect(await readDurableEntry(fixture.repoPath, fixture.id)).toBeUndefined();
    expect(await readDurableEntry(fixture.repoPath, fixture.unrelatedId)).toBeDefined();
  } finally {
    errorSpy.mockRestore();
    closeDb();
  }
}, 60_000);

it('does not record a retirement completion claim when dependency cleanup fails late', async () => {
  const fixture = await setupTrackedWorkspace(`late-failure-${Date.now()}`, { dependencyImage: true });
  const { closeDb } = await import('@/lib/db');
  rmSync(fixture.worktreePath, { recursive: true, force: true });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const outcome = await cleanupOutcome(fixture.repoPath, fixture.id);
    const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
    const { getLaneEvents } = await import('@/lib/lane/registry');
    const metadataRetained = (await readDurableEntry(fixture.repoPath, fixture.id)) !== undefined;
    const events = getLaneEvents(fixture.lane.id);
    const observed = events.filter((event) => event.verb === 'workspace_absence_observed');
    const completionClaims = events.filter((event) => event.verb === 'workspace_retirement_confirmed');

    expect(outcome).not.toBe('retired');
    expect(metadataRetained).toBe(true);
    expect(getWorkspaceSnapshot(fixture.repo.id, fixture.id)).toBeNull();
    expect(observed).toHaveLength(1);
    expect(completionClaims).toHaveLength(0);
    expect(completionClaims.length > 0 && metadataRetained).toBe(false);
  } finally {
    errorSpy.mockRestore();
    closeDb();
  }
}, 60_000);

it('retains unique committed work when cleaning up a missing directory twice', async () => {
  const fixture = await setupTrackedWorkspace(`branch-preservation-${Date.now()}`, {
    gitWorktree: true,
  });
  writeFileSync(path.join(fixture.worktreePath, 'unique.txt'), 'unique committed work\n');
  execFileSync('git', ['add', 'tracked.txt', 'unique.txt'], { cwd: fixture.worktreePath });
  execFileSync('git', [
    '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',
    'commit', '-q', '-m', 'unique work',
  ], { cwd: fixture.worktreePath });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture.worktreePath,
    encoding: 'utf8',
  }).trim();
  const main = execFileSync('git', ['rev-parse', 'main'], {
    cwd: fixture.repoPath,
    encoding: 'utf8',
  }).trim();
  expect(head).not.toBe(main);
  rmSync(fixture.worktreePath, { recursive: true, force: true });

  for (let pass = 0; pass < 2; pass += 1) {
    expect(await cleanupOutcome(fixture.repoPath, fixture.id)).toBe('retired');
    expect(await readDurableEntry(fixture.repoPath, fixture.id)).toBeUndefined();
    const retainedHead = execFileSync('git', [
      'rev-parse', '--verify', `refs/heads/${fixture.branch}`,
    ], { cwd: fixture.repoPath, encoding: 'utf8' }).trim();
    expect(retainedHead).toBe(head);
    expect(execFileSync('git', ['show', `${retainedHead}:unique.txt`], {
      cwd: fixture.repoPath,
      encoding: 'utf8',
    })).toBe('unique committed work\n');
  }
}, 60_000);
