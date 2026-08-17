import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import type { WorktreeMetaStore } from '@/lib/worktree/types';
import type { ProcessQuiescenceReceipt } from './process-quiescence';
import { recoverGitWorktreeAdminReceipt } from './worktree-exact-identity';
import { prepareExactWorkspaceClaim, readExactWorkspaceClaim } from './exact-workspace-claim-state';
import {
  captureExactDirectoryManifestFingerprint,
} from './exact-directory-purge';
import {
  inspectExactWorktreeQuarantine,
  discardPreparedExactRestore,
  locateExactWorktreeQuarantine,
  parkExactWorktree,
  resolveExactWorktreeQuarantine,
  restoreExactWorktree,
  type ExactWorktreeQuarantineLocatorInput,
  type ExactWorktreeQuarantineReceipt,
} from './worktree-exact';

const roots: string[] = [];
let priorWorktreeRoot: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

function processReceipt(
  sessionKey: string,
  state: ProcessQuiescenceReceipt['state'] = 'quiescent',
  pid?: number,
): ProcessQuiescenceReceipt {
  return {
    state,
    identity: {
      ownership: 'owned',
      pidIdentity: 'not_applicable',
      sessionKey,
    },
    probes: pid ? [{ primitive: 'filesystem_users', state: 'live', detail: 'Test run.', pids: [pid] }] : [],
    reasons: [],
    checkedAt: new Date().toISOString(),
  };
}

function quiescentProbe(sessionKey = 'test-owned:session') {
  return async (actualSessionKey: string): Promise<ProcessQuiescenceReceipt> => {
    expect(actualSessionKey).toBe(sessionKey);
    return processReceipt(sessionKey);
  };
}

function verifyCleanGitQuarantine(expectedHead: string) {
  return async (quarantinePath: string) => {
    expect(git(quarantinePath, 'rev-parse', 'HEAD')).toBe(expectedHead);
    if (git(quarantinePath, 'status', '--porcelain=v1', '--untracked-files=all')) {
      throw new Error('quarantined Git content changed');
    }
  };
}

function quarantineInput(
  f: ReturnType<typeof fixture>,
  snapshotFingerprint = `snapshot-${f.worktreeId}`,
): ExactWorktreeQuarantineLocatorInput {
  return {
    repoPath: f.repo,
    worktreeId: f.worktreeId,
    expectedPath: f.worktree,
    quarantine: { snapshotFingerprint, intent: 'park' },
  };
}

function fixture(label: string, kind: 'git-worktree' | 'apfs-cow-clone' = 'git-worktree') {
  const root = mkdtempSync(path.join(os.tmpdir(), `o8-exact-${label}-`));
  roots.push(root);
  process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'o8-test@example.test');
  git(repo, 'config', 'user.name', 'o8 test');
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, 'add', '.gitignore', 'tracked.txt');
  git(repo, 'commit', '-qm', 'base');
  const baseHead = git(repo, 'rev-parse', 'HEAD');
  const worktreeId = 'packet-test';
  const layout = resolveWorktreeRootLayout(repo);
  const worktree = path.join(layout.primaryBase, worktreeId);
  mkdirSync(layout.primaryBase, { recursive: true });
  if (kind === 'git-worktree') {
    git(repo, 'worktree', 'add', '-qb', 'inline/test', worktree, 'HEAD');
  } else {
    git(repo, 'clone', '-q', '--local', '--no-checkout', repo, worktree);
    git(worktree, 'config', 'user.email', 'o8-test@example.test');
    git(worktree, 'config', 'user.name', 'o8 test');
    git(worktree, 'checkout', '-qb', 'inline/test', baseHead);
  }
  writeFileSync(path.join(worktree, 'tracked.txt'), 'changed\n');
  git(worktree, 'add', 'tracked.txt');
  git(worktree, 'commit', '-qm', 'packet change');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
  const meta: WorktreeMetaStore = {
    version: 1,
    worktrees: {
      [worktreeId]: {
        id: worktreeId,
        agentType: 'codex',
        sessionKey: 'test-owned:session',
        baseBranch: 'main',
        createdAt: 1,
        claudeManaged: false,
        taskName: worktreeId,
        branchName: 'inline/test',
        status: 'ready',
        isolationKind: kind,
        materializationIdentity: {
          device: lstatSync(worktree).dev,
          inode: lstatSync(worktree).ino,
          canonicalPath: realpathSync(worktree),
        },
      },
    },
  };
  const metaPath = path.join(layout.primaryBase, '.meta.json');
  writeFileSync(metaPath, JSON.stringify(meta));
  return { repo, worktree, worktreeId, head, tree, baseHead, kind, metaPath };
}

interface RestoreProcessInput {
  repoPath: string;
  worktreeId: string;
  expectedPath: string;
  branch: string;
  head: string;
  tree: string;
  baseBranch: string;
  agentType: string;
  createdAt: number;
  isolationKind: 'git-worktree';
}

function parkedPairFixture(label: string): {
  inputs: [RestoreProcessInput, RestoreProcessInput];
  metaPath: string;
  expectedEntryCount: number;
} {
  const first = fixture(label);
  const layout = resolveWorktreeRootLayout(first.repo);
  const secondId = 'packet-peer';
  const secondPath = path.join(layout.primaryBase, secondId);
  git(first.repo, 'worktree', 'add', '-qb', 'inline/peer', secondPath, first.baseHead);
  writeFileSync(path.join(secondPath, 'tracked.txt'), 'peer change\n');
  git(secondPath, 'add', 'tracked.txt');
  git(secondPath, 'commit', '-qm', 'peer change');
  const secondHead = git(secondPath, 'rev-parse', 'HEAD');
  const secondTree = git(secondPath, 'rev-parse', 'HEAD^{tree}');
  git(first.repo, 'worktree', 'remove', first.worktree);
  git(first.repo, 'worktree', 'remove', secondPath);

  const filler: WorktreeMetaStore['worktrees'] = {};
  for (let index = 0; index < 5_000; index += 1) {
    const id = `retained-${index}`;
    filler[id] = {
      id,
      agentType: 'codex',
      baseBranch: 'main',
      createdAt: index,
      claudeManaged: false,
      taskName: id,
      status: 'ready',
      isolationKind: 'git-worktree',
    };
  }
  const metaPath = path.join(layout.primaryBase, '.meta.json');
  writeFileSync(metaPath, JSON.stringify({ version: 1, worktrees: filler } satisfies WorktreeMetaStore));
  return {
    inputs: [{
      repoPath: first.repo,
      worktreeId: first.worktreeId,
      expectedPath: first.worktree,
      branch: 'inline/test',
      head: first.head,
      tree: first.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'git-worktree',
    }, {
      repoPath: first.repo,
      worktreeId: secondId,
      expectedPath: secondPath,
      branch: 'inline/peer',
      head: secondHead,
      tree: secondTree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 2,
      isolationKind: 'git-worktree',
    }],
    metaPath,
    expectedEntryCount: Object.keys(filler).length + 2,
  };
}

async function runRestoreProcess(
  runnerPath: string,
  barrierDir: string,
  allIds: string[],
  input: RestoreProcessInput,
): Promise<{ code: number | null; stderr: string }> {
  return runNodeProcess(runnerPath, {
    RESTORE_INPUT: JSON.stringify(input),
    RESTORE_BARRIER_DIR: barrierDir,
    RESTORE_ALL_IDS: JSON.stringify(allIds),
  });
}

async function runNodeProcess(
  runnerPath: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim();
  const child = spawn(process.execPath, ['--import', 'tsx', runnerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      NODE_OPTIONS: [inheritedNodeOptions, '--conditions=react-server'].filter(Boolean).join(' '),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const [code] = await once(child, 'close') as [number | null];
  return { code, stderr };
}

async function waitForRestoreCreatorExit(repoPath: string, worktreeId: string): Promise<void> {
  const claim = readExactWorkspaceClaim('restore-creation', repoPath, worktreeId);
  const pid = claim?.authority?.creatorPid;
  const identity = claim?.authority?.creatorProcessIdentity;
  expect(Number.isInteger(pid)).toBe(true);
  expect(isMetadataLockProcessIdentity(identity)).toBe(true);
  if (!Number.isInteger(pid) || !isMetadataLockProcessIdentity(identity)) {
    throw new Error('Restore creator authority is missing from the trusted claim.');
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const probe = await probeMetadataLockProcessIdentity(Number(pid));
    if (probe.state === 'absent'
      || (probe.state === 'live'
        && !sameMetadataLockProcessIdentity(probe.identity, identity))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Restore creator did not exit after its parent process stopped.');
}

beforeEach(() => {
  priorWorktreeRoot = process.env.O8_WORKTREE_ROOT;
});

afterEach(() => {
  if (priorWorktreeRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
  else process.env.O8_WORKTREE_ROOT = priorWorktreeRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exact managed worktree parking', { timeout: 90_000 }, () => {
  it('parks and restores a Git worktree while preserving exact branch truth', async () => {
    const f = fixture('git-roundtrip');
    mkdirSync(path.join(f.worktree, 'node_modules'));
    writeFileSync(path.join(f.worktree, 'node_modules', 'cache'), 'rebuildable');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'git-roundtrip', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    })).resolves.toBe('git-worktree');
    expect(existsSync(f.worktree)).toBe(false);

    await restoreExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      sessionKey: 'test-owned:session',
      createdAt: 1,
      isolationKind: 'git-worktree',
    });
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(readFileSync(path.join(f.worktree, 'tracked.txt'), 'utf8')).toBe('changed\n');
  });

  it('does not accumulate quarantine or retirement namespaces across repeated parks', async () => {
    const f = fixture('repeated-park-retirement');
    const managedBase = path.dirname(f.worktree);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await parkExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        expectedBranch: 'inline/test',
        expectedHead: f.head,
        expectedSessionKey: 'test-owned:session',
        probeProcessQuiescence: quiescentProbe(),
        quarantine: { snapshotFingerprint: `repeated-park-${attempt}`, intent: 'park' },
        verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
      });
      expect(readdirSync(managedBase).filter((name) => (
        name.startsWith('.o8-park-workspace-')
        || name.startsWith('.o8-retired-tree-')
        || name.startsWith('.o8-retired-.o8-park-workspace-')
      ))).toEqual([]);
      await restoreExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        branch: 'inline/test',
        head: f.head,
        tree: f.tree,
        baseBranch: 'main',
        agentType: 'codex',
        sessionKey: 'test-owned:session',
        createdAt: 1,
        isolationKind: 'git-worktree',
      });
    }
  }, 90_000);

  it('restores the exact Git inode when writes land at the final rename boundary', async () => {
    const f = fixture('git-late-content');
    const untrackedPath = path.join(f.worktree, 'late-untracked.txt');
    const ignoredPath = path.join(f.worktree, 'node_modules', 'late-ignored.txt');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'git-late-content', intent: 'park' },
      beforeQuarantineRename: async () => {
        writeFileSync(path.join(f.worktree, 'tracked.txt'), 'staged late write\n');
        git(f.worktree, 'add', 'tracked.txt');
        writeFileSync(path.join(f.worktree, 'tracked.txt'), 'unstaged late write\n');
        writeFileSync(untrackedPath, 'late untracked bytes\n');
        mkdirSync(path.dirname(ignoredPath), { recursive: true });
        writeFileSync(ignoredPath, 'late ignored bytes\n');
      },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    })).rejects.toThrow('quarantined Git content changed');

    expect(readFileSync(path.join(f.worktree, 'tracked.txt'), 'utf8')).toBe('unstaged late write\n');
    expect(readFileSync(untrackedPath, 'utf8')).toBe('late untracked bytes\n');
    expect(readFileSync(ignoredPath, 'utf8')).toBe('late ignored bytes\n');
  });

  it('retains the path when a source write lands after the earlier scan boundary', async () => {
    const f = fixture('late-write');
    writeFileSync(path.join(f.worktree, 'late-untracked.txt'), 'must survive\n');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'late-write', intent: 'park' },
    })).rejects.toThrow();
    expect(existsSync(path.join(f.worktree, 'late-untracked.txt'))).toBe(true);
    const meta = JSON.parse(readFileSync(path.join(resolveWorktreeRootLayout(f.repo).primaryBase, '.meta.json'), 'utf8')) as WorktreeMetaStore;
    expect(meta.worktrees[f.worktreeId]).toBeDefined();
  });

  it('never follows a replacement symlink into external bytes at the Git removal boundary', async () => {
    const f = fixture('git-symlink-swap');
    const externalPath = path.join(path.dirname(f.repo), 'externally-owned-worktree');
    const sentinelPath = path.join(externalPath, 'node_modules', 'external-sentinel.txt');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      beforeQuarantineRename: async () => {
        renameSync(f.worktree, externalPath);
        mkdirSync(path.dirname(sentinelPath), { recursive: true });
        writeFileSync(sentinelPath, 'external bytes must survive\n');
        symlinkSync(externalPath, f.worktree, 'dir');
      },
      quarantine: { snapshotFingerprint: 'git-symlink-swap', intent: 'park' },
    })).rejects.toThrow('changed source identity');

    expect(lstatSync(f.worktree).isSymbolicLink()).toBe(true);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('external bytes must survive\n');
    expect(git(externalPath, 'rev-parse', 'HEAD')).toBe(f.head);
  });

  it.each([
    ['git-worktree', 'receipt'],
    ['git-worktree', 'rename'],
    ['apfs-cow-clone', 'receipt'],
    ['apfs-cow-clone', 'rename'],
  ] as const)(
    'pins the managed parent for %s quarantine %s publication',
    async (kind, phase) => {
      const f = fixture(`quarantine-parent-${kind}-${phase}`, kind);
      if (kind === 'apfs-cow-clone') git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
      const managedBase = path.dirname(f.worktree);
      const retainedBase = `${managedBase}.receipted`;
      const replacementSentinel = path.join(managedBase, 'unrelated-sentinel');
      const swapParent = async () => {
        renameSync(managedBase, retainedBase);
        mkdirSync(managedBase);
        writeFileSync(replacementSentinel, 'must survive\n');
      };

      await expect(parkExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        expectedBranch: 'inline/test',
        expectedHead: f.head,
        expectedSessionKey: 'test-owned:session',
        probeProcessQuiescence: quiescentProbe(),
        quarantine: { snapshotFingerprint: `quarantine-parent-${kind}-${phase}`, intent: 'park' },
        verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
        ...(phase === 'receipt'
          ? { beforeQuarantineReceiptWrite: swapParent }
          : { beforeQuarantineRename: swapParent }),
      })).rejects.toThrow('Managed workspace ownership changed before process execution');

      expect(readFileSync(replacementSentinel, 'utf8')).toBe('must survive\n');
      expect(readFileSync(path.join(retainedBase, f.worktreeId, 'tracked.txt'), 'utf8'))
        .toBe('changed\n');
    },
  );

  it.each([
    ['git-worktree', 'claim'],
    ['git-worktree', 'purge'],
    ['git-worktree', 'restore'],
    ['apfs-cow-clone', 'claim'],
    ['apfs-cow-clone', 'purge'],
    ['apfs-cow-clone', 'restore'],
  ] as const)(
    'pins the managed parent for %s quarantine %s transition',
    async (kind, phase) => {
      const f = fixture(`quarantine-transition-parent-${kind}-${phase}`, kind);
      if (kind === 'apfs-cow-clone') git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
      const managedBase = path.dirname(f.worktree);
      const retainedBase = `${managedBase}.receipted`;
      const replacementSentinel = path.join(managedBase, 'unrelated-sentinel');
      const swapParent = async () => {
        renameSync(managedBase, retainedBase);
        mkdirSync(managedBase);
        writeFileSync(replacementSentinel, 'must survive\n');
      };

      await expect(parkExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        expectedBranch: 'inline/test',
        expectedHead: f.head,
        expectedSessionKey: 'test-owned:session',
        probeProcessQuiescence: quiescentProbe(),
        quarantine: {
          snapshotFingerprint: `quarantine-transition-parent-${kind}-${phase}`,
          intent: 'park',
        },
        verifyQuarantinedClone: phase === 'restore'
          ? async () => { throw new Error('force exact rollback'); }
          : verifyCleanGitQuarantine(f.head),
        ...(phase === 'claim' ? { beforeQuarantineClaim: swapParent } : {}),
        ...(phase === 'purge' ? { beforeQuarantinePurgeRename: swapParent } : {}),
        ...(phase === 'restore' ? { beforeQuarantineRestoreRename: swapParent } : {}),
      })).rejects.toThrow('Managed workspace ownership changed before process execution');

      expect(readFileSync(replacementSentinel, 'utf8')).toBe('must survive\n');
      const retainedWorkspace = readdirSync(retainedBase)
        .map((name) => path.join(retainedBase, name))
        .find((candidate) => {
          try {
            return lstatSync(candidate).isDirectory()
              && existsSync(path.join(candidate, 'tracked.txt'));
          } catch {
            return false;
          }
        });
      expect(retainedWorkspace).toBeTruthy();
      expect(readFileSync(path.join(retainedWorkspace!, 'tracked.txt'), 'utf8')).toBe('changed\n');
    },
  );

  it('preserves a replacement swapped after final quarantine verification', async () => {
    const f = fixture('git-final-claim-swap');
    const locator = quarantineInput(f, 'git-final-claim-swap');
    const location = locateExactWorktreeQuarantine(locator);
    const receiptedWorktree = path.join(path.dirname(f.repo), 'receipted-worktree-survives');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: locator.quarantine,
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
      beforeQuarantineClaim: async () => {
        renameSync(location.quarantinePath, receiptedWorktree);
        mkdirSync(location.quarantinePath);
        writeFileSync(path.join(location.quarantinePath, 'unrelated-sentinel'), 'must survive\n');
      },
    })).rejects.toThrow('changed source identity');

    expect(git(receiptedWorktree, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(readFileSync(
      path.join(location.quarantinePath, 'unrelated-sentinel'),
      'utf8',
    )).toBe('must survive\n');
  });

  it('preserves a Git replacement swapped after claim identity proof', async () => {
    const f = fixture('git-purge-capture-swap');
    const locator = quarantineInput(f, 'git-purge-capture-swap');
    const location = locateExactWorktreeQuarantine(locator);
    const receiptedWorktree = path.join(path.dirname(f.repo), 'claimed-worktree-survives');
    let replacementPath = '';

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: locator.quarantine,
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
      beforeClaimedPurge: async (claimedPath) => {
        renameSync(claimedPath, receiptedWorktree);
        mkdirSync(claimedPath);
        replacementPath = claimedPath;
        writeFileSync(path.join(claimedPath, 'unrelated-sentinel'), 'must survive\n');
      },
    })).rejects.toThrow('Exact purge captured an unexpected directory identity');

    expect(git(receiptedWorktree, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(readFileSync(path.join(replacementPath, 'unrelated-sentinel'), 'utf8'))
      .toBe('must survive\n');
    expect(existsSync(location.receiptPath)).toBe(true);
  });

  it('finishes one exact Git quarantine after a crash immediately following rename', async () => {
    const f = fixture('git-quarantine-crash');
    const locator = quarantineInput(f, 'git-quarantine-crash');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: locator.quarantine,
      afterQuarantineRename: async () => { throw new Error('synthetic crash after rename'); },
    })).rejects.toThrow('synthetic crash after rename');

    const interrupted = await inspectExactWorktreeQuarantine(locator);
    expect(interrupted).toMatchObject({ state: 'quarantined', originalExists: false });
    await expect(resolveExactWorktreeQuarantine({
      ...locator,
      disposition: 'remove',
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      verifyQuarantinedClone: async (quarantinePath) => {
        expect(git(quarantinePath, 'rev-parse', 'HEAD')).toBe(f.head);
      },
    })).resolves.toBe('removed');
    expect(existsSync(f.worktree)).toBe(false);
    expect(git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain(f.worktree);
    const meta = JSON.parse(readFileSync(
      path.join(resolveWorktreeRootLayout(f.repo).primaryBase, '.meta.json'),
      'utf8',
    )) as WorktreeMetaStore;
    expect(meta.worktrees[f.worktreeId]).toBeUndefined();
  });

  it.each(['git-worktree', 'apfs-cow-clone'] as const)(
    'finishes an exact %s park after a process death during content release',
    async (kind) => {
      const f = fixture(`content-release-crash-${kind}`, kind);
      const locator = quarantineInput(f, `content-release-crash-${kind}`);
      const runnerPath = path.join(path.dirname(f.repo), `content-release-crash-${kind}.ts`);
      const moduleUrl = pathToFileURL(
        path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts'),
      ).href;
      writeFileSync(runnerPath, `
        import { execFileSync } from 'node:child_process';
        import { parkExactWorktree } from ${JSON.stringify(moduleUrl)};
        const input = JSON.parse(process.env.O8_EXACT_PARK_INPUT);
        void parkExactWorktree({
          ...input,
          probeProcessQuiescence: async (sessionKey) => ({
            state: 'quiescent',
            identity: { ownership: 'owned', pidIdentity: 'not_applicable', sessionKey },
            probes: [],
            reasons: [],
            checkedAt: new Date().toISOString(),
          }),
          verifyQuarantinedClone: async (quarantinePath) => {
            const head = execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: quarantinePath,
              encoding: 'utf8',
            }).trim();
            if (head !== input.expectedHead) throw new Error('unexpected quarantine head');
          },
          afterClaimedContentRelease: async () => {
            process.stdout.write('O8_CONTENT_RELEASED\\n');
            await new Promise(() => {});
          },
        }).catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      `);
      const child = spawn(process.execPath, ['--import', 'tsx', runnerPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          O8_EXACT_PARK_INPUT: JSON.stringify({
            repoPath: f.repo,
            worktreeId: f.worktreeId,
            expectedPath: f.worktree,
            expectedBranch: 'inline/test',
            expectedHead: f.head,
            expectedSessionKey: 'test-owned:session',
            quarantine: locator.quarantine,
          }),
          NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), '--conditions=react-server']
            .filter(Boolean)
            .join(' '),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const deadline = Date.now() + 20_000;
      while (!stdout.includes('O8_CONTENT_RELEASED')) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Exact park child exited before content release: ${stderr}`);
        }
        if (Date.now() >= deadline) throw new Error(`Exact park child timed out: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;

      await expect(inspectExactWorktreeQuarantine(locator)).resolves.toMatchObject({
        state: 'purging',
        originalExists: false,
        quarantineExists: true,
      });
      await expect(resolveExactWorktreeQuarantine({
        ...locator,
        disposition: 'remove',
        expectedSessionKey: 'test-owned:session',
        probeProcessQuiescence: quiescentProbe(),
        verifyQuarantinedClone: async () => {
          throw new Error('Content verification must not run after the durable purge boundary.');
        },
      })).resolves.toBe('removed');
      expect(existsSync(f.worktree)).toBe(false);
      await expect(inspectExactWorktreeQuarantine(locator)).resolves.toMatchObject({ state: 'clear' });
      const meta = JSON.parse(readFileSync(
        path.join(resolveWorktreeRootLayout(f.repo).primaryBase, '.meta.json'),
        'utf8',
      )) as WorktreeMetaStore;
      expect(meta.worktrees[f.worktreeId]).toBeUndefined();
    },
    60_000,
  );

  it('finishes trusted receipt retirement after a process death between mirror and claim cleanup', async () => {
    const f = fixture('receipt-retirement-crash');
    const locator = quarantineInput(f, 'receipt-retirement-crash');
    const runnerPath = path.join(path.dirname(f.repo), 'receipt-retirement-crash.ts');
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts'),
    ).href;
    writeFileSync(runnerPath, `
      import { execFileSync } from 'node:child_process';
      import { parkExactWorktree } from ${JSON.stringify(moduleUrl)};
      const input = JSON.parse(process.env.O8_EXACT_PARK_INPUT);
      void parkExactWorktree({
        ...input,
        probeProcessQuiescence: async (sessionKey) => ({
          state: 'quiescent',
          identity: { ownership: 'owned', pidIdentity: 'not_applicable', sessionKey },
          probes: [],
          reasons: [],
          checkedAt: new Date().toISOString(),
        }),
        verifyQuarantinedClone: async (quarantinePath) => {
          const head = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: quarantinePath,
            encoding: 'utf8',
          }).trim();
          if (head !== input.expectedHead) throw new Error('unexpected quarantine head');
        },
        afterQuarantineReceiptRetired: async () => {
          process.stdout.write('O8_RECEIPT_RETIRED\\n');
          await new Promise(() => {});
        },
      }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        O8_EXACT_PARK_INPUT: JSON.stringify({
          repoPath: f.repo,
          worktreeId: f.worktreeId,
          expectedPath: f.worktree,
          expectedBranch: 'inline/test',
          expectedHead: f.head,
          expectedSessionKey: 'test-owned:session',
          quarantine: locator.quarantine,
        }),
        NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), '--conditions=react-server']
          .filter(Boolean)
          .join(' '),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const deadline = Date.now() + 20_000;
    while (!stdout.includes('O8_RECEIPT_RETIRED')) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Exact park child exited before receipt retirement: ${stderr}`);
      }
      if (Date.now() >= deadline) throw new Error(`Exact park child timed out: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;

    await expect(inspectExactWorktreeQuarantine(locator)).resolves.toMatchObject({ state: 'clear' });
    await expect(restoreExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      sessionKey: 'test-owned:session',
      createdAt: 1,
      isolationKind: 'git-worktree',
    })).resolves.toBeUndefined();
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
  }, 60_000);

  it('retires a pre-mirror claim after process death and permits a new park generation', async () => {
    const f = fixture('pre-mirror-claim-crash');
    const interrupted = quarantineInput(f, 'pre-mirror-claim-crash');
    const runnerPath = path.join(path.dirname(f.repo), 'pre-mirror-claim-crash.ts');
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts'),
    ).href;
    writeFileSync(runnerPath, `
      import { parkExactWorktree } from ${JSON.stringify(moduleUrl)};
      const input = JSON.parse(process.env.O8_EXACT_PARK_INPUT);
      void parkExactWorktree({
        ...input,
        probeProcessQuiescence: async (sessionKey) => ({
          state: 'quiescent',
          identity: { ownership: 'owned', pidIdentity: 'not_applicable', sessionKey },
          probes: [],
          reasons: [],
          checkedAt: new Date().toISOString(),
        }),
        beforeQuarantineReceiptWrite: async () => {
          process.stdout.write('O8_CLAIM_PREPARED\\n');
          await new Promise(() => {});
        },
      }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        O8_EXACT_PARK_INPUT: JSON.stringify({
          repoPath: f.repo,
          worktreeId: f.worktreeId,
          expectedPath: f.worktree,
          expectedBranch: 'inline/test',
          expectedHead: f.head,
          expectedSessionKey: 'test-owned:session',
          quarantine: interrupted.quarantine,
        }),
        NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), '--conditions=react-server']
          .filter(Boolean)
          .join(' '),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const deadline = Date.now() + 20_000;
    while (!stdout.includes('O8_CLAIM_PREPARED')) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Exact park child exited before claim preparation: ${stderr}`);
      }
      if (Date.now() >= deadline) throw new Error(`Exact park child timed out: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;

    expect(existsSync(f.worktree)).toBe(true);
    await expect(inspectExactWorktreeQuarantine(interrupted)).resolves.toMatchObject({ state: 'clear' });
    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'pre-mirror-next-generation', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    })).resolves.toBe('git-worktree');
    expect(existsSync(f.worktree)).toBe(false);
  }, 60_000);

  it('fails closed before removal when shared worktree metadata is corrupt', async () => {
    const f = fixture('corrupt-meta');
    const metaPath = path.join(resolveWorktreeRootLayout(f.repo).primaryBase, '.meta.json');
    writeFileSync(metaPath, '{invalid');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'corrupt-meta', intent: 'park' },
    })).rejects.toThrow();
    expect(existsSync(f.worktree)).toBe(true);
    expect(readFileSync(metaPath, 'utf8')).toBe('{invalid');
  });

  it('ignores and preserves the retired metadata lock pathname during removal', async () => {
    const f = fixture('retired-meta-lock');
    const lockPath = path.join(resolveWorktreeRootLayout(f.repo).primaryBase, '.meta.json.lock');
    mkdirSync(lockPath);
    const unexpectedPath = path.join(lockPath, 'unrelated');
    writeFileSync(unexpectedPath, 'must survive');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'retired-meta-lock', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    })).resolves.toBe('git-worktree');
    expect(existsSync(f.worktree)).toBe(false);
    expect(readFileSync(unexpectedPath, 'utf8')).toBe('must survive');
  });

  it('preserves both packet entries across concurrent cross-process restores', async () => {
    const f = parkedPairFixture('concurrent-meta');
    const runnerPath = path.join(path.dirname(f.metaPath), 'restore-runner.ts');
    const barrierDir = path.join(path.dirname(f.metaPath), 'restore-barrier');
    mkdirSync(barrierDir);
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts')).href;
    writeFileSync(runnerPath, `
      import { access, writeFile } from 'node:fs/promises';
      import path from 'node:path';
      import { restoreExactWorktree } from ${JSON.stringify(moduleUrl)};
      async function main() {
        const input = JSON.parse(process.env.RESTORE_INPUT);
        const barrierDir = process.env.RESTORE_BARRIER_DIR;
        const allIds = JSON.parse(process.env.RESTORE_ALL_IDS);
        await writeFile(path.join(barrierDir, input.worktreeId), 'ready');
        const deadline = Date.now() + 10_000;
        for (;;) {
          const ready = await Promise.all(allIds.map((id) =>
            access(path.join(barrierDir, id)).then(() => true, () => false)));
          if (ready.every(Boolean)) break;
          if (Date.now() >= deadline) throw new Error('restore barrier timed out');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await restoreExactWorktree(input);
      }
      void main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);
    const ids = f.inputs.map((input) => input.worktreeId);

    const results = await Promise.all(f.inputs.map((input) => (
      runRestoreProcess(runnerPath, barrierDir, ids, input)
    )));
    expect(results.map((result) => result.code), JSON.stringify(results)).toEqual([0, 0]);
    const meta = JSON.parse(readFileSync(f.metaPath, 'utf8')) as WorktreeMetaStore;
    expect(meta.worktrees[f.inputs[0].worktreeId]).toMatchObject({ id: f.inputs[0].worktreeId });
    expect(meta.worktrees[f.inputs[1].worktreeId]).toMatchObject({ id: f.inputs[1].worktreeId });
    expect(Object.keys(meta.worktrees)).toHaveLength(f.expectedEntryCount);
  }, 30_000);

  it('preserves manager and exact entries across concurrent cross-process writes', async () => {
    const f = parkedPairFixture('concurrent-manager-exact');
    const runnerPath = path.join(path.dirname(f.metaPath), 'manager-exact-runner.ts');
    const barrierDir = path.join(path.dirname(f.metaPath), 'manager-exact-barrier');
    mkdirSync(barrierDir);
    const exactModuleUrl = pathToFileURL(
      path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts'),
    ).href;
    const managerModuleUrl = pathToFileURL(
      path.join(process.cwd(), 'src/lib/worktree/manager.ts'),
    ).href;
    writeFileSync(runnerPath, `
      import { access, writeFile } from 'node:fs/promises';
      import path from 'node:path';
      import { restoreExactWorktree } from ${JSON.stringify(exactModuleUrl)};
      import { WorktreeManager } from ${JSON.stringify(managerModuleUrl)};
      async function main() {
        const participant = process.env.PARTICIPANT_ID;
        const barrierDir = process.env.RESTORE_BARRIER_DIR;
        const allIds = JSON.parse(process.env.RESTORE_ALL_IDS);
        await writeFile(path.join(barrierDir, participant), 'ready');
        const deadline = Date.now() + 10_000;
        for (;;) {
          const ready = await Promise.all(allIds.map((id) =>
            access(path.join(barrierDir, id)).then(() => true, () => false)));
          if (ready.every(Boolean)) break;
          if (Date.now() >= deadline) throw new Error('manager/exact barrier timed out');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (process.env.PROCESS_ROLE === 'exact') {
          await restoreExactWorktree(JSON.parse(process.env.RESTORE_INPUT));
          return;
        }
        const manager = new WorktreeManager(process.env.REPO_PATH);
        await manager.create({
          agentType: 'claude-code',
          taskName: 'manager peer',
          branchName: 'inline/manager-peer',
          managed: false,
        });
      }
      void main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);
    const exactId = f.inputs[0].worktreeId;
    const allIds = [exactId, 'manager-peer'];
    const shared = {
      RESTORE_BARRIER_DIR: barrierDir,
      RESTORE_ALL_IDS: JSON.stringify(allIds),
      REPO_PATH: f.inputs[0].repoPath,
    };

    const results = await Promise.all([
      runNodeProcess(runnerPath, {
        ...shared,
        PROCESS_ROLE: 'exact',
        PARTICIPANT_ID: exactId,
        RESTORE_INPUT: JSON.stringify(f.inputs[0]),
      }),
      runNodeProcess(runnerPath, {
        ...shared,
        PROCESS_ROLE: 'manager',
        PARTICIPANT_ID: 'manager-peer',
      }),
    ]);
    expect(results.map((result) => result.code), JSON.stringify(results)).toEqual([0, 0]);
    const meta = JSON.parse(readFileSync(f.metaPath, 'utf8')) as WorktreeMetaStore;
    expect(meta.worktrees[exactId]).toMatchObject({ id: exactId });
    expect(meta.worktrees['manager-peer']).toMatchObject({ id: 'manager-peer' });
    expect(Object.keys(meta.worktrees)).toHaveLength(f.expectedEntryCount);
  }, 30_000);

  it('retains the exact path when a real run appears after the earlier process proof', async () => {
    const f = fixture('late-process');
    const earlier = processReceipt('test-owned:session');
    expect(earlier.state).toBe('quiescent');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: f.worktree,
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    try {
      await expect(parkExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        expectedBranch: 'inline/test',
        expectedHead: f.head,
        expectedSessionKey: 'test-owned:session',
        probeProcessQuiescence: async (sessionKey, workspacePath) => {
          expect(sessionKey).toBe('test-owned:session');
          expect(workspacePath).toBe(f.worktree);
          process.kill(child.pid!, 0);
          return processReceipt(sessionKey, 'live', child.pid!);
        },
        quarantine: { snapshotFingerprint: 'late-process', intent: 'park' },
      })).rejects.toThrow('fresh owned-workspace process quiescence was not proved');
      expect(existsSync(f.worktree)).toBe(true);
      const meta = JSON.parse(readFileSync(
        path.join(resolveWorktreeRootLayout(f.repo).primaryBase, '.meta.json'),
        'utf8',
      )) as WorktreeMetaStore;
      expect(meta.worktrees[f.worktreeId]).toBeDefined();
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
  });

  it('round-trips a copy-on-write clone through atomic quarantine', async () => {
    const f = fixture('cow-roundtrip', 'apfs-cow-clone');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    git(f.repo, 'update-ref', 'refs/o8/recovery/repo/packet', f.head);
    let quarantineObserved = false;

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'cow-roundtrip', intent: 'park' },
      verifyQuarantinedClone: async (quarantinePath) => {
        quarantineObserved = existsSync(quarantinePath) && !existsSync(f.worktree);
        expect(git(quarantinePath, 'rev-parse', 'HEAD')).toBe(f.head);
      },
    })).resolves.toBe('apfs-cow-clone');
    expect(quarantineObserved).toBe(true);

    await restoreExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone',
    });
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
  });

  it('receipts the prepared source tree after a rebuildable dependency detach', async () => {
    const f = fixture('cow-prepared-manifest', 'apfs-cow-clone');
    const dependencyPath = path.join(f.worktree, 'node_modules', 'fixture-package', 'index.js');
    mkdirSync(path.dirname(dependencyPath), { recursive: true });
    writeFileSync(dependencyPath, 'module.exports = "mounted";\n');
    const location = locateExactWorktreeQuarantine(
      quarantineInput(f, 'cow-prepared-manifest'),
    );
    const events: string[] = [];

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: async (sessionKey, workspacePath) => {
        events.push(workspacePath === f.worktree ? 'source-process' : 'quarantine-process');
        return processReceipt(sessionKey);
      },
      quarantine: { snapshotFingerprint: 'cow-prepared-manifest', intent: 'park' },
      prepareQuarantineSource: async (workspacePath) => {
        events.push('prepare');
        rmSync(path.join(workspacePath, 'node_modules'), { recursive: true });
        mkdirSync(path.join(workspacePath, 'node_modules'));
      },
      afterQuarantineRename: async () => {
        const receipt = JSON.parse(
          readFileSync(location.receiptPath, 'utf8'),
        ) as ExactWorktreeQuarantineReceipt;
        const receiptedPaths = receipt.sourceManifest?.map((entry) => entry.relative) ?? [];
        expect(receiptedPaths).toContain('node_modules');
        expect(receiptedPaths)
          .not.toContain('node_modules/fixture-package');
      },
      verifyQuarantinedClone: async (quarantinePath) => {
        expect(existsSync(path.join(quarantinePath, 'node_modules'))).toBe(true);
        expect(existsSync(path.join(quarantinePath, 'node_modules', 'fixture-package'))).toBe(false);
      },
    })).resolves.toBe('apfs-cow-clone');

    expect(events).toEqual([
      'source-process',
      'prepare',
      'source-process',
      'quarantine-process',
    ]);
  });

  it('never deletes an APFS replacement symlink with matching Git truth and ignored external bytes', async () => {
    const f = fixture('cow-symlink-swap', 'apfs-cow-clone');
    const externalPath = path.join(path.dirname(f.repo), 'externally-owned-clone');
    const sentinelPath = path.join(externalPath, 'node_modules', 'external-sentinel.txt');
    let verifierCalled = false;

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'cow-symlink-swap', intent: 'park' },
      beforeQuarantineRename: async () => {
        renameSync(f.worktree, externalPath);
        mkdirSync(path.dirname(sentinelPath), { recursive: true });
        writeFileSync(sentinelPath, 'external clone bytes must survive\n');
        symlinkSync(externalPath, f.worktree, 'dir');
      },
      verifyQuarantinedClone: async () => { verifierCalled = true; },
    })).rejects.toThrow('changed source identity');

    expect(verifierCalled).toBe(false);
    expect(lstatSync(f.worktree).isSymbolicLink()).toBe(true);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('external clone bytes must survive\n');
    expect(git(externalPath, 'rev-parse', 'HEAD')).toBe(f.head);
  });

  it('preserves an APFS replacement swapped after final quarantine verification', async () => {
    const f = fixture('cow-final-claim-swap', 'apfs-cow-clone');
    const locator = quarantineInput(f, 'cow-final-claim-swap');
    const location = locateExactWorktreeQuarantine(locator);
    const receiptedClone = path.join(path.dirname(f.repo), 'receipted-clone-survives');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: locator.quarantine,
      verifyQuarantinedClone: async (quarantinePath) => {
        expect(git(quarantinePath, 'rev-parse', 'HEAD')).toBe(f.head);
      },
      beforeQuarantineClaim: async () => {
        renameSync(location.quarantinePath, receiptedClone);
        mkdirSync(location.quarantinePath);
        writeFileSync(path.join(location.quarantinePath, 'unrelated-sentinel'), 'must survive\n');
      },
    })).rejects.toThrow('changed source identity');

    expect(git(receiptedClone, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(readFileSync(
      path.join(location.quarantinePath, 'unrelated-sentinel'),
      'utf8',
    )).toBe('must survive\n');
  });

  it('preserves an APFS replacement swapped after claim identity proof', async () => {
    const f = fixture('cow-purge-capture-swap', 'apfs-cow-clone');
    const locator = quarantineInput(f, 'cow-purge-capture-swap');
    const location = locateExactWorktreeQuarantine(locator);
    const receiptedClone = path.join(path.dirname(f.repo), 'claimed-clone-survives');
    let replacementPath = '';

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: locator.quarantine,
      verifyQuarantinedClone: async (quarantinePath) => {
        expect(git(quarantinePath, 'rev-parse', 'HEAD')).toBe(f.head);
      },
      beforeClaimedPurge: async (claimedPath) => {
        renameSync(claimedPath, receiptedClone);
        mkdirSync(claimedPath);
        replacementPath = claimedPath;
        writeFileSync(path.join(claimedPath, 'unrelated-sentinel'), 'must survive\n');
      },
    })).rejects.toThrow('Exact purge captured an unexpected directory identity');

    expect(git(receiptedClone, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(readFileSync(path.join(replacementPath, 'unrelated-sentinel'), 'utf8'))
      .toBe('must survive\n');
    expect(existsSync(location.receiptPath)).toBe(true);
  });

  it('preserves a nested replacement swapped after the exact purge tree capture', async () => {
    const f = fixture('cow-nested-purge-swap', 'apfs-cow-clone');
    const locator = quarantineInput(f, 'cow-nested-purge-swap');
    const originalNested = path.join(path.dirname(f.repo), 'captured-node-modules-survives');
    const nestedPath = path.join(f.worktree, 'node_modules');
    mkdirSync(nestedPath);
    writeFileSync(path.join(nestedPath, 'cache.bin'), 'rebuildable cache\n');

    let replacementPath = '';
    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: locator.quarantine,
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
      afterClaimedTreeCapture: async (claimedPath) => {
        const claimedNested = path.join(claimedPath, 'node_modules');
        renameSync(claimedNested, originalNested);
        mkdirSync(claimedNested);
        replacementPath = claimedNested;
        writeFileSync(path.join(claimedNested, 'unrelated-sentinel'), 'must survive\n');
      },
    })).rejects.toThrow('Exact purge tree identity changed after capture');

    expect(readFileSync(path.join(originalNested, 'cache.bin'), 'utf8')).toBe('rebuildable cache\n');
    expect(readFileSync(path.join(replacementPath, 'unrelated-sentinel'), 'utf8')).toBe('must survive\n');
  });

  it('refuses to park a clean same-HEAD replacement that lacks the manager inode receipt', async () => {
    const f = fixture('cow-initial-owner-swap', 'apfs-cow-clone');
    const ownedWorktree = path.join(path.dirname(f.repo), 'owned-worktree-retained');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    renameSync(f.worktree, ownedWorktree);
    git(f.repo, 'clone', '-q', '--local', '--no-checkout', f.repo, f.worktree);
    git(f.worktree, 'checkout', '-q', '-B', 'inline/test', f.head);
    writeFileSync(path.join(f.worktree, 'unrelated-sentinel'), 'must survive\n');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'cow-initial-owner-swap', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    })).rejects.toThrow('managed workspace ownership is absent or changed');

    expect(git(ownedWorktree, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(readFileSync(path.join(f.worktree, 'unrelated-sentinel'), 'utf8')).toBe('must survive\n');
  });

  it('refuses a same-repository Git marker swapped A to B to A during admin capture', async () => {
    const f = fixture('git-admin-marker-aba');
    const victimPath = path.join(path.dirname(f.worktree), 'packet-victim');
    git(f.repo, 'worktree', 'add', '-qb', 'inline/victim', victimPath, f.head);
    mkdirSync(path.join(victimPath, 'node_modules'));
    const sentinel = path.join(victimPath, 'node_modules', 'sentinel');
    writeFileSync(sentinel, 'victim-bytes');
    const markerPath = path.join(f.worktree, '.git');
    const originalMarker = readFileSync(markerPath, 'utf8');
    const victimMarker = readFileSync(path.join(victimPath, '.git'), 'utf8');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'git-admin-marker-aba', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
      afterGitAdminMarkerLstat: async () => writeFileSync(markerPath, victimMarker),
      afterGitAdminMarkerRead: async () => writeFileSync(markerPath, originalMarker),
    })).rejects.toThrow(/marker identity changed|different workspace marker/);

    expect(readFileSync(sentinel, 'utf8')).toBe('victim-bytes');
    expect(existsSync(f.worktree)).toBe(true);
    expect(existsSync(victimPath)).toBe(true);
    expect(git(victimPath, 'rev-parse', 'HEAD')).toBe(f.head);
  });

  it('refuses a nested replacement swapped in before the exact purge tree capture', async () => {
    const f = fixture('cow-nested-pre-capture-swap', 'apfs-cow-clone');
    const locator = quarantineInput(f, 'cow-nested-pre-capture-swap');
    const originalNested = path.join(path.dirname(f.repo), 'pre-capture-node-modules-survives');
    const nestedPath = path.join(f.worktree, 'node_modules');
    mkdirSync(nestedPath);
    writeFileSync(path.join(nestedPath, 'cache.bin'), 'rebuildable cache\n');

    let replacementPath = '';
    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: locator.quarantine,
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
      beforeClaimedPurge: async (claimedPath) => {
        const claimedNested = path.join(claimedPath, 'node_modules');
        renameSync(claimedNested, originalNested);
        mkdirSync(claimedNested);
        replacementPath = claimedNested;
        writeFileSync(path.join(claimedNested, 'unrelated-sentinel'), 'must survive\n');
      },
    })).rejects.toThrow(/fingerprint changed before capture|not a monotonic subset/);

    expect(readFileSync(path.join(originalNested, 'cache.bin'), 'utf8')).toBe('rebuildable cache\n');
    expect(readFileSync(path.join(replacementPath, 'unrelated-sentinel'), 'utf8')).toBe('must survive\n');
  });

  it('retains an occupied restore destination without touching its bytes', async () => {
    const f = fixture('restore-occupied', 'apfs-cow-clone');
    const sentinel = path.join(f.worktree, 'external-sentinel.txt');
    writeFileSync(sentinel, 'belongs to another writer\n');
    const metadata = JSON.parse(readFileSync(f.metaPath, 'utf8')) as WorktreeMetaStore;
    delete metadata.worktrees[f.worktreeId]?.materializationIdentity;
    writeFileSync(f.metaPath, JSON.stringify(metadata));

    await expect(restoreExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone',
    })).rejects.toThrow('original path is occupied');
    expect(readFileSync(sentinel, 'utf8')).toBe('belongs to another writer\n');
  });

  it('refuses invalid immutable truth before materializing the staged path', async () => {
    const f = fixture('restore-verification-failure', 'apfs-cow-clone');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    rmSync(f.worktree, { recursive: true });
    writeFileSync(path.join(path.dirname(f.worktree), '.meta.json'), JSON.stringify({
      version: 1,
      worktrees: {},
    } satisfies WorktreeMetaStore));

    await expect(restoreExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: '0'.repeat(40),
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone',
    })).rejects.toThrow('does not match its immutable branch, commit, and tree');
    expect(existsSync(f.worktree)).toBe(false);
  });

  it.each(['git-worktree', 'apfs-cow-clone'] as const)(
    'refuses a same-HEAD destination swap before restore ownership commits for %s',
    async (kind) => {
      const f = fixture(`restore-owner-swap-${kind}`, kind);
      if (kind === 'apfs-cow-clone') {
        git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
      }
      await parkExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        expectedBranch: 'inline/test',
        expectedHead: f.head,
        expectedSessionKey: 'test-owned:session',
        probeProcessQuiescence: quiescentProbe(),
        quarantine: { snapshotFingerprint: `restore-owner-swap-${kind}`, intent: 'park' },
        verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
      });
      const retainedRestore = `${f.worktree}-owned-restore`;

      await expect(restoreExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        branch: 'inline/test',
        head: f.head,
        tree: f.tree,
        baseBranch: 'main',
        agentType: 'codex',
        sessionKey: 'test-owned:session',
        createdAt: 1,
        isolationKind: kind,
        beforeRestoreOwnershipCommit: async () => {
          renameSync(f.worktree, retainedRestore);
          git(f.repo, 'clone', '-q', '--local', '--no-checkout', f.repo, f.worktree);
          git(f.worktree, 'checkout', '-q', '--detach', f.head);
          writeFileSync(path.join(f.worktree, 'unrelated-sentinel'), 'must survive\n');
        },
      })).rejects.toThrow(/path identity changed|materialized path was retained/);

      expect(readFileSync(path.join(f.worktree, 'unrelated-sentinel'), 'utf8')).toBe('must survive\n');
      expect(git(retainedRestore, 'rev-parse', 'HEAD')).toBe(f.head);
      const metaPath = path.join(path.dirname(f.worktree), '.meta.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as WorktreeMetaStore;
      expect(meta.worktrees[f.worktreeId]?.materializationIdentity).toBeDefined();
    },
  );

  it('refuses to park a restored path whose persisted directory identity was replaced', async () => {
    const f = fixture('restore-owner-later-swap');
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-owner-later-swap', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });
    await restoreExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      sessionKey: 'test-owned:session',
      createdAt: 1,
      isolationKind: 'git-worktree',
    });
    const retainedRestore = `${f.worktree}-owned-restore`;
    renameSync(f.worktree, retainedRestore);
    git(f.repo, 'clone', '-q', '--local', '--no-checkout', f.repo, f.worktree);
    git(f.worktree, 'checkout', '-q', '--detach', f.head);
    writeFileSync(path.join(f.worktree, 'unrelated-sentinel'), 'must survive\n');

    await expect(parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-owner-later-swap-2', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    })).rejects.toThrow('managed workspace ownership is absent or changed');
    expect(readFileSync(path.join(f.worktree, 'unrelated-sentinel'), 'utf8')).toBe('must survive\n');
  });

  it.each(['git-worktree', 'apfs-cow-clone'] as const)(
    'does not populate a replacement swapped into the receipted final target for %s',
    async (kind) => {
      const f = fixture(`restore-stage-pre-create-swap-${kind}`, kind);
      if (kind === 'apfs-cow-clone') git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
      await parkExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        expectedBranch: 'inline/test',
        expectedHead: f.head,
        expectedSessionKey: 'test-owned:session',
        probeProcessQuiescence: quiescentProbe(),
        quarantine: { snapshotFingerprint: `restore-stage-pre-create-swap-${kind}`, intent: 'park' },
        verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
      });
      let retainedTarget = '';

      await expect(restoreExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        branch: 'inline/test',
        head: f.head,
        tree: f.tree,
        baseBranch: 'main',
        agentType: 'codex',
        createdAt: 1,
        isolationKind: kind,
        afterRestoreStagePrepared: async () => {
          retainedTarget = `${f.worktree}.receipted`;
          renameSync(f.worktree, retainedTarget);
          mkdirSync(f.worktree);
          writeFileSync(path.join(f.worktree, 'unrelated-sentinel'), 'must survive\n');
        },
      })).rejects.toThrow('Restore cleanup remains durably claimed');

      expect(readFileSync(path.join(f.worktree, 'unrelated-sentinel'), 'utf8'))
        .toBe('must survive\n');
      expect(readdirSync(retainedTarget)).toEqual([]);
    },
    60_000,
  );

  it.each(['git-worktree', 'apfs-cow-clone'] as const)(
    'does not publish a replacement swapped into the empty restore claim for %s',
    async (kind) => {
      const f = fixture(`restore-stage-swap-${kind}`, kind);
      if (kind === 'apfs-cow-clone') git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
      await parkExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        expectedBranch: 'inline/test',
        expectedHead: f.head,
        expectedSessionKey: 'test-owned:session',
        probeProcessQuiescence: quiescentProbe(),
        quarantine: { snapshotFingerprint: `restore-stage-swap-${kind}`, intent: 'park' },
        verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
      });
      let retainedStage = '';
      let replacementStage = '';

      await expect(restoreExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        branch: 'inline/test',
        head: f.head,
        tree: f.tree,
        baseBranch: 'main',
        agentType: 'codex',
        createdAt: 1,
        isolationKind: kind,
        beforeRestoreStageMove: async (stagePath) => {
          retainedStage = `${stagePath}.receipted`;
          replacementStage = stagePath;
          renameSync(stagePath, retainedStage);
          git(f.repo, 'clone', '-q', '--local', '--no-checkout', f.repo, stagePath);
          git(stagePath, 'checkout', '-q', '--detach', f.head);
          writeFileSync(path.join(stagePath, 'unrelated-sentinel'), 'must survive\n');
        },
      })).rejects.toThrow('Restore cleanup remains durably claimed');

      expect(existsSync(f.worktree)).toBe(false);
      expect(readdirSync(retainedStage)).toEqual([]);
      expect(readFileSync(path.join(replacementStage, 'unrelated-sentinel'), 'utf8'))
        .toBe('must survive\n');
    },
    60_000,
  );

  it('retires a receipted partially populated restore stage before retrying', async () => {
    const f = fixture('restore-partial-population', 'apfs-cow-clone');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-partial-population', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });

    await expect(restoreExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone',
      afterRestorePopulationCommand: async (completed) => {
        if (completed === 2) throw new Error('simulated partial population stop');
      },
    })).rejects.toThrow('simulated partial population stop');
    expect(existsSync(f.worktree)).toBe(false);

    await expect(restoreExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone',
    })).resolves.toBeUndefined();
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
  }, 90_000);

  it('retires an empty receipted stage when failure is thrown immediately after creation', async () => {
    const f = fixture('restore-stage-created-failure', 'apfs-cow-clone');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-stage-created-failure', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });
    const restoreInput = {
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone' as const,
    };
    await expect(restoreExactWorktree({
      ...restoreInput,
      afterRestoreStageCreated: async () => {
        throw new Error('simulated post-create failure');
      },
    })).rejects.toThrow('simulated post-create failure');
    expect(JSON.parse(readFileSync(f.metaPath, 'utf8')).worktrees[f.worktreeId]).toBeUndefined();
    expect(readdirSync(path.dirname(f.worktree)).some((name) => name.startsWith('.o8-restore-stage-')))
      .toBe(false);
    await expect(restoreExactWorktree(restoreInput)).resolves.toBeUndefined();
  }, 60_000);

  it('replays a crash after durable restore intent but before target creation', async () => {
    const f = fixture('restore-pre-target-crash', 'apfs-cow-clone');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-pre-target-crash', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });
    const restoreInput = {
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone' as const,
    };
    const runnerPath = path.join(path.dirname(f.repo), 'pre-target-restore-child.ts');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts')).href;
    writeFileSync(runnerPath, `
      import { restoreExactWorktree } from ${JSON.stringify(moduleUrl)};
      async function main() {
        const input = JSON.parse(process.env.RESTORE_INPUT);
        await restoreExactWorktree({
          ...input,
          afterRestoreIntentPrepared: async () => process.exit(87),
        });
      }
      void main();
    `);
    const child = await runNodeProcess(runnerPath, { RESTORE_INPUT: JSON.stringify(restoreInput) });
    expect(child.code, child.stderr).toBe(87);
    expect(existsSync(f.worktree)).toBe(false);
    expect(JSON.parse(readFileSync(f.metaPath, 'utf8')).worktrees[f.worktreeId]
      .materializationIdentity).toBeUndefined();

    await expect(discardPreparedExactRestore(restoreInput)).resolves.toBe('absent');
    await expect(restoreExactWorktree(restoreInput)).resolves.toBeUndefined();
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
  }, 90_000);

  it('replays a parent crash after the child CASes target ownership', async () => {
    const f = fixture('restore-child-receipt-crash', 'apfs-cow-clone');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-child-receipt-crash', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });
    const restoreInput = {
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone' as const,
    };
    const runnerPath = path.join(path.dirname(f.repo), 'child-receipt-restore-parent.ts');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts')).href;
    writeFileSync(runnerPath, `
      import { restoreExactWorktree } from ${JSON.stringify(moduleUrl)};
      async function main() {
        const input = JSON.parse(process.env.RESTORE_INPUT);
        await restoreExactWorktree({
          ...input,
          beforeRestoreReceiptCommit: async () => process.exit(88),
        });
      }
      void main();
    `);
    const child = await runNodeProcess(runnerPath, { RESTORE_INPUT: JSON.stringify(restoreInput) });
    expect(child.code, child.stderr).toBe(88);
    const prepared = JSON.parse(readFileSync(f.metaPath, 'utf8')) as WorktreeMetaStore;
    const preparation = prepared.worktrees[f.worktreeId]!.restorePreparation!;
    expect(existsSync(f.worktree)).toBe(false);
    expect(existsSync(preparation.stagePath)).toBe(true);
    expect(prepared.worktrees[f.worktreeId]!.materializationIdentity).toBeUndefined();
    expect(preparation.claimOperationId).toBeTruthy();

    await expect(discardPreparedExactRestore(restoreInput)).resolves.toBe('removed');
    expect(existsSync(f.worktree)).toBe(false);
    expect(existsSync(preparation.stagePath)).toBe(false);
    await expect(restoreExactWorktree(restoreInput)).resolves.toBeUndefined();
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
  }, 90_000);

  it('replays a parent crash before the restore child creates its empty claim', async () => {
    const f = fixture('restore-parent-crash-before-create', 'apfs-cow-clone');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-parent-crash-before-create', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });
    const restoreInput = {
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone' as const,
    };
    const runnerPath = path.join(path.dirname(f.repo), 'restore-parent-before-create.ts');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts')).href;
    writeFileSync(runnerPath, `
      import { restoreExactWorktree } from ${JSON.stringify(moduleUrl)};
      async function main() {
        const input = JSON.parse(process.env.RESTORE_INPUT);
        await restoreExactWorktree({
          ...input,
          beforeRestoreClaimCreate: async () => process.kill(process.pid, 'SIGKILL'),
        });
      }
      void main();
    `);
    const child = await runNodeProcess(runnerPath, { RESTORE_INPUT: JSON.stringify(restoreInput) });
    expect(child.code, child.stderr).toBeNull();
    await waitForRestoreCreatorExit(f.repo, f.worktreeId);
    const prepared = JSON.parse(readFileSync(f.metaPath, 'utf8')) as WorktreeMetaStore;
    const claimPath = prepared.worktrees[f.worktreeId]!.restorePreparation!.stagePath;
    expect(existsSync(claimPath)).toBe(false);
    await expect(discardPreparedExactRestore(restoreInput)).resolves.toBe('absent');
    await expect(restoreExactWorktree(restoreInput)).resolves.toBeUndefined();
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
  }, 90_000);

  it('retires an empty pre-CAS claim after both restore processes stop', async () => {
    const f = fixture('restore-child-crash-before-cas', 'apfs-cow-clone');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-child-crash-before-cas', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });
    const restoreInput = {
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone' as const,
    };
    const runnerPath = path.join(path.dirname(f.repo), 'restore-child-before-cas.ts');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts')).href;
    writeFileSync(runnerPath, `
      import { restoreExactWorktree } from ${JSON.stringify(moduleUrl)};
      async function main() {
        const input = JSON.parse(process.env.RESTORE_INPUT);
        await restoreExactWorktree({
          ...input,
          beforeRestoreClaimCas: async () => process.kill(process.pid, 'SIGKILL'),
        });
      }
      void main();
    `);
    const child = await runNodeProcess(runnerPath, { RESTORE_INPUT: JSON.stringify(restoreInput) });
    expect(child.code, child.stderr).toBeNull();
    await waitForRestoreCreatorExit(f.repo, f.worktreeId);
    const prepared = JSON.parse(readFileSync(f.metaPath, 'utf8')) as WorktreeMetaStore;
    const claimPath = prepared.worktrees[f.worktreeId]!.restorePreparation!.stagePath;
    expect(existsSync(claimPath)).toBe(true);
    await expect(discardPreparedExactRestore(restoreInput)).resolves.toBe('absent');
    expect(existsSync(claimPath)).toBe(false);
    await expect(restoreExactWorktree(restoreInput)).resolves.toBeUndefined();
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
  }, 90_000);

  it('retires a published claim after a crash following ready metadata', async () => {
    const f = fixture('restore-ready-claim-crash', 'apfs-cow-clone');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-ready-claim-crash', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });
    const restoreInput = {
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone' as const,
    };
    const runnerPath = path.join(path.dirname(f.repo), 'ready-claim-restore-parent.ts');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts')).href;
    writeFileSync(runnerPath, `
      import { restoreExactWorktree } from ${JSON.stringify(moduleUrl)};
      async function main() {
        const input = JSON.parse(process.env.RESTORE_INPUT);
        await restoreExactWorktree({
          ...input,
          afterRestoreReadyCommit: async () => process.exit(89),
        });
      }
      void main();
    `);
    const child = await runNodeProcess(runnerPath, { RESTORE_INPUT: JSON.stringify(restoreInput) });
    expect(child.code, child.stderr).toBe(89);
    const ready = JSON.parse(readFileSync(f.metaPath, 'utf8')) as WorktreeMetaStore;
    expect(ready.worktrees[f.worktreeId]).toMatchObject({ status: 'ready' });
    expect(ready.worktrees[f.worktreeId]!.restorePreparation).toBeUndefined();

    await expect(restoreExactWorktree(restoreInput)).resolves.toBeUndefined();
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
  }, 90_000);

  it('replays exact stage retirement after a crash before metadata retirement', async () => {
    const f = fixture('restore-stage-retirement-replay', 'git-worktree');
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-stage-retirement-replay', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });
    const restoreInput = {
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'git-worktree' as const,
    };
    const runnerPath = path.join(path.dirname(f.repo), 'partial-restore-child.ts');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts')).href;
    writeFileSync(runnerPath, `
      import { restoreExactWorktree } from ${JSON.stringify(moduleUrl)};
      async function main() {
        const input = JSON.parse(process.env.RESTORE_INPUT);
        await restoreExactWorktree({
          ...input,
          afterRestorePopulationCommand: async (completed) => {
            if (completed === 1) process.exit(86);
          },
        });
      }
      void main();
    `);
    const child = await runNodeProcess(runnerPath, { RESTORE_INPUT: JSON.stringify(restoreInput) });
    expect(child.code, child.stderr).toBe(86);

    const preparedMeta = JSON.parse(readFileSync(f.metaPath, 'utf8')) as WorktreeMetaStore;
    expect(preparedMeta.worktrees[f.worktreeId]!.restorePreparation).toBeDefined();
    const activeTarget = f.worktree;
    const retainedGitFile = path.join(activeTarget, '.git.receipted');
    renameSync(path.join(activeTarget, '.git'), retainedGitFile);
    await expect(discardPreparedExactRestore({
      ...restoreInput,
      afterPreparedTargetRetired: async () => {
        throw new Error('simulated crash before Git-admin cleanup');
      },
    })).rejects.toThrow('simulated crash before Git-admin cleanup');
    expect(existsSync(activeTarget)).toBe(false);
    expect(JSON.parse(readFileSync(f.metaPath, 'utf8')).worktrees[f.worktreeId]
      .restorePreparation.cleanupPhase).toBe('target-retired');

    await expect(discardPreparedExactRestore({
      ...restoreInput,
      afterPreparedStageRetired: async () => {
        throw new Error('simulated crash before metadata retirement');
      },
    })).rejects.toThrow('simulated crash before metadata retirement');
    expect(JSON.parse(readFileSync(f.metaPath, 'utf8')).worktrees[f.worktreeId]).toBeDefined();
    await expect(discardPreparedExactRestore(restoreInput)).resolves.toBe('absent');
    expect(JSON.parse(readFileSync(f.metaPath, 'utf8')).worktrees[f.worktreeId]).toBeUndefined();
    await expect(restoreExactWorktree(restoreInput)).resolves.toBeUndefined();
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
  }, 90_000);

  it('recovers a killed Git population with a missing target marker', async () => {
    const f = fixture('restore-git-population-kill', 'git-worktree');
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-git-population-kill', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });
    const restoreInput = {
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'git-worktree' as const,
    };
    const runnerPath = path.join(path.dirname(f.repo), 'restore-git-population-kill.ts');
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/lib/workspace/worktree-exact.ts')).href;
    writeFileSync(runnerPath, `
      import { rmSync } from 'node:fs';
      import path from 'node:path';
      import { restoreExactWorktree } from ${JSON.stringify(moduleUrl)};
      async function main() {
        const input = JSON.parse(process.env.RESTORE_INPUT);
        await restoreExactWorktree({
          ...input,
          afterRestorePopulationCommand: async () => {
            rmSync(path.join(input.expectedPath, '.git'));
            process.kill(process.pid, 'SIGKILL');
          },
        });
      }
      void main();
    `);
    const child = await runNodeProcess(runnerPath, { RESTORE_INPUT: JSON.stringify(restoreInput) });
    expect(child.code, child.stderr).toBeNull();
    expect(existsSync(f.worktree)).toBe(true);
    expect(existsSync(path.join(f.worktree, '.git'))).toBe(false);
    const recoveredAdmin = await recoverGitWorktreeAdminReceipt(f.repo, f.worktree);
    expect(recoveredAdmin.gitAdminPath).not.toBeNull();

    await expect(discardPreparedExactRestore(restoreInput)).resolves.toBe('removed');
    expect(existsSync(f.worktree)).toBe(false);
    expect(existsSync(recoveredAdmin.gitAdminPath!)).toBe(false);
    await expect(restoreExactWorktree(restoreInput)).resolves.toBeUndefined();
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
  }, 90_000);

  it('does not touch an occupant introduced after direct target population', async () => {
    const f = fixture('restore-final-destination', 'apfs-cow-clone');
    git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
    await parkExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      expectedBranch: 'inline/test',
      expectedHead: f.head,
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      quarantine: { snapshotFingerprint: 'restore-final-destination', intent: 'park' },
      verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
    });

    await expect(restoreExactWorktree({
      repoPath: f.repo,
      worktreeId: f.worktreeId,
      expectedPath: f.worktree,
      branch: 'inline/test',
      head: f.head,
      tree: f.tree,
      baseBranch: 'main',
      agentType: 'codex',
      createdAt: 1,
      isolationKind: 'apfs-cow-clone',
      beforeRestoreStageMove: async (targetPath) => {
        renameSync(targetPath, `${targetPath}.receipted`);
        mkdirSync(f.worktree);
        writeFileSync(path.join(f.worktree, 'unrelated-sentinel'), 'must survive\n');
      },
    })).rejects.toThrow('Restore cleanup remains durably claimed');
    expect(readFileSync(path.join(f.worktree, 'unrelated-sentinel'), 'utf8')).toBe('must survive\n');
  }, 60_000);

  it.each(['git-worktree', 'apfs-cow-clone'] as const)(
    'does not follow a destination symlink introduced at the exact %s publish boundary',
    async (kind) => {
      const f = fixture(`restore-final-symlink-${kind}`, kind);
      if (kind === 'apfs-cow-clone') git(f.repo, 'fetch', '-q', '--no-tags', f.worktree, f.head);
      await parkExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        expectedBranch: 'inline/test',
        expectedHead: f.head,
        expectedSessionKey: 'test-owned:session',
        probeProcessQuiescence: quiescentProbe(),
        quarantine: { snapshotFingerprint: `restore-final-symlink-${kind}`, intent: 'park' },
        verifyQuarantinedClone: verifyCleanGitQuarantine(f.head),
      });
      const external = path.join(path.dirname(f.worktree), `external-${kind}`);
      mkdirSync(external);
      writeFileSync(path.join(external, 'unrelated-sentinel'), 'must survive\n');

      await expect(restoreExactWorktree({
        repoPath: f.repo,
        worktreeId: f.worktreeId,
        expectedPath: f.worktree,
        branch: 'inline/test',
        head: f.head,
        tree: f.tree,
        baseBranch: 'main',
        agentType: 'codex',
        createdAt: 1,
        isolationKind: kind,
        beforeRestoreStagePublish: async (targetPath) => {
          renameSync(targetPath, `${targetPath}.receipted`);
          symlinkSync(external, f.worktree, 'dir');
        },
      })).rejects.toThrow('Restore cleanup remains durably claimed');

      expect(lstatSync(f.worktree).isSymbolicLink()).toBe(true);
      expect(readdirSync(external)).toEqual(['unrelated-sentinel']);
      expect(readFileSync(path.join(external, 'unrelated-sentinel'), 'utf8')).toBe('must survive\n');
    },
    30_000,
  );

  it('recognizes and removes only an exact receipted copy-on-write quarantine orphan', async () => {
    const f = fixture('cow-orphan', 'apfs-cow-clone');
    const input = quarantineInput(f, 'cow-orphan-snapshot');
    const location = locateExactWorktreeQuarantine(input);
    mkdirSync(location.quarantineRoot, { recursive: true });
    const sourceIdentity = lstatSync(f.worktree);
    const sourceManifestFingerprint = await captureExactDirectoryManifestFingerprint(
      f.worktree,
      { device: sourceIdentity.dev, inode: sourceIdentity.ino },
    );
    const receipt: ExactWorktreeQuarantineReceipt = {
      version: 1,
      kind: 'o8-exact-worktree-quarantine',
      identity: location.identity,
      intent: input.quarantine.intent,
      snapshotFingerprint: input.quarantine.snapshotFingerprint,
      repoPath: path.resolve(f.repo),
      worktreeId: f.worktreeId,
      originalPath: location.originalPath,
      quarantinePath: location.quarantinePath,
      sourceDevice: lstatSync(f.worktree).dev,
      sourceInode: lstatSync(f.worktree).ino,
      sourceManifestFingerprint,
      quarantineRootDevice: lstatSync(location.quarantineRoot).dev,
      quarantineRootInode: lstatSync(location.quarantineRoot).ino,
      canonicalQuarantineRoot: realpathSync(location.quarantineRoot),
      gitAdminPath: null,
      gitAdminDevice: null,
      gitAdminInode: null,
      createdAt: new Date().toISOString(),
    };
    prepareExactWorkspaceClaim({
      kind: 'worktree-quarantine',
      repositoryPath: f.repo,
      worktreeId: f.worktreeId,
      operationId: location.identity,
      expectedPath: location.originalPath,
      sourcePath: location.originalPath,
      claimPath: location.quarantinePath,
      parentIdentity: {
        device: receipt.quarantineRootDevice,
        inode: receipt.quarantineRootInode,
        canonicalPath: receipt.canonicalQuarantineRoot,
      },
      sourceIdentity: { device: receipt.sourceDevice, inode: receipt.sourceInode },
      contentDigest: receipt.sourceManifestFingerprint,
      authority: {
        sourceManifest: receipt.sourceManifest,
        gitAdminPath: null,
        gitAdminDevice: null,
        gitAdminInode: null,
      },
    });
    writeFileSync(location.receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    renameSync(f.worktree, location.quarantinePath);
    const unrelated = path.join(location.quarantineRoot, 'unrelated-owned-by-someone-else');
    mkdirSync(unrelated);

    const inspection = await inspectExactWorktreeQuarantine(input);
    expect(inspection, inspection.note).toMatchObject({
      state: 'quarantined',
      originalExists: false,
      quarantineExists: true,
      receiptExists: true,
    });
    await expect(resolveExactWorktreeQuarantine({
      ...input,
      disposition: 'remove',
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      verifyQuarantinedClone: async (quarantinePath) => {
        expect(quarantinePath).toBe(location.quarantinePath);
        expect(git(quarantinePath, 'rev-parse', 'HEAD')).toBe(f.head);
      },
    })).resolves.toBe('removed');
    expect(existsSync(location.quarantinePath)).toBe(false);
    expect(existsSync(location.receiptPath)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('refuses an exact quarantine path without its matching ownership receipt', async () => {
    const f = fixture('cow-untrusted', 'apfs-cow-clone');
    const input = quarantineInput(f, 'cow-untrusted-snapshot');
    const location = locateExactWorktreeQuarantine(input);
    mkdirSync(location.quarantineRoot, { recursive: true });
    renameSync(f.worktree, location.quarantinePath);

    await expect(inspectExactWorktreeQuarantine(input)).resolves.toMatchObject({ state: 'untrusted' });
    await expect(resolveExactWorktreeQuarantine({
      ...input,
      disposition: 'remove',
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      verifyQuarantinedClone: async () => {},
    })).rejects.toThrow('has no matching ownership receipt');
    expect(existsSync(location.quarantinePath)).toBe(true);
  });

  it('refuses a forged receipt and preserves a swapped clean same-HEAD victim', async () => {
    const f = fixture('forged-quarantine-victim', 'apfs-cow-clone');
    const input = quarantineInput(f, 'forged-quarantine-victim');
    const location = locateExactWorktreeQuarantine(input);
    const originalStat = lstatSync(f.worktree);
    const originalFingerprint = await captureExactDirectoryManifestFingerprint(
      f.worktree,
      { device: originalStat.dev, inode: originalStat.ino },
    );
    const rootStat = lstatSync(location.quarantineRoot);
    const canonicalRoot = realpathSync(location.quarantineRoot);
    prepareExactWorkspaceClaim({
      kind: 'worktree-quarantine',
      repositoryPath: f.repo,
      worktreeId: f.worktreeId,
      operationId: location.identity,
      expectedPath: location.originalPath,
      sourcePath: location.originalPath,
      claimPath: location.quarantinePath,
      parentIdentity: {
        device: rootStat.dev,
        inode: rootStat.ino,
        canonicalPath: canonicalRoot,
      },
      sourceIdentity: { device: originalStat.dev, inode: originalStat.ino },
      contentDigest: originalFingerprint,
      authority: {
        gitAdminPath: null,
        gitAdminDevice: null,
        gitAdminInode: null,
      },
    });
    const retainedOriginal = `${f.worktree}.owned-original`;
    renameSync(f.worktree, retainedOriginal);
    git(f.repo, 'clone', '-q', '--local', retainedOriginal, location.quarantinePath);
    writeFileSync(path.join(location.quarantinePath, '.git', 'info', 'exclude'), 'unrelated-sentinel\n');
    writeFileSync(path.join(location.quarantinePath, 'unrelated-sentinel'), 'must survive\n');
    expect(git(location.quarantinePath, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(git(location.quarantinePath, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    const victimStat = lstatSync(location.quarantinePath);
    const victimFingerprint = await captureExactDirectoryManifestFingerprint(
      location.quarantinePath,
      { device: victimStat.dev, inode: victimStat.ino },
    );
    const forged: ExactWorktreeQuarantineReceipt = {
      version: 1,
      kind: 'o8-exact-worktree-quarantine',
      identity: location.identity,
      intent: input.quarantine.intent,
      snapshotFingerprint: input.quarantine.snapshotFingerprint,
      repoPath: path.resolve(f.repo),
      worktreeId: f.worktreeId,
      originalPath: location.originalPath,
      quarantinePath: location.quarantinePath,
      sourceDevice: victimStat.dev,
      sourceInode: victimStat.ino,
      sourceManifestFingerprint: victimFingerprint,
      quarantineRootDevice: rootStat.dev,
      quarantineRootInode: rootStat.ino,
      canonicalQuarantineRoot: canonicalRoot,
      gitAdminPath: null,
      gitAdminDevice: null,
      gitAdminInode: null,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(location.receiptPath, `${JSON.stringify(forged)}\n`, { mode: 0o600 });

    await expect(resolveExactWorktreeQuarantine({
      ...input,
      disposition: 'remove',
      expectedSessionKey: 'test-owned:session',
      probeProcessQuiescence: quiescentProbe(),
      verifyQuarantinedClone: async () => {
        throw new Error('forged occupant must never reach verification');
      },
    })).rejects.toThrow('not trusted');
    expect(readFileSync(path.join(location.quarantinePath, 'unrelated-sentinel'), 'utf8'))
      .toBe('must survive\n');
    expect(existsSync(retainedOriginal)).toBe(true);
  });
});
