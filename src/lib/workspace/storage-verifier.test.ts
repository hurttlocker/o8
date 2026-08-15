import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureWorkspaceRegularFileIdentity,
  compareWorkspaceStorageScans,
  scanWorkspaceStorageState,
  type WorkspaceStorageVerifierOptions,
} from './storage-verifier';

const tempPaths: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeRepo(label: string): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), `o8-${label}-`));
  tempPaths.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'o8-test@example.test');
  git(repo, 'config', 'user.name', 'o8 test');
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, 'add', 'tracked.txt');
  git(repo, 'commit', '-qm', 'base');
  return repo;
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('workspace storage verifier', () => {
  it('returns verified_clean only for a bounded Git-clean filesystem', async () => {
    const repo = await makeRepo('storage-clean');
    const scan = await scanWorkspaceStorageState(repo);

    expect(scan.state).toBe('verified_clean');
    expect(scan.findings).toEqual([]);
    expect(scan.canonicalWorkspacePath).toBe(await realpath(repo));
  });

  it('reports staged, unstaged, untracked, and undeclared ignored work', async () => {
    const repo = await makeRepo('storage-dirty');
    writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
    writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
    git(repo, 'add', '.gitignore', 'staged.txt');
    git(repo, 'commit', '-qm', 'ignore');
    writeFileSync(path.join(repo, 'staged-two.txt'), 'staged\n');
    git(repo, 'add', 'staged-two.txt');
    writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n');
    writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
    writeFileSync(path.join(repo, 'ignored.txt'), 'ignored\n');

    const scan = await scanWorkspaceStorageState(repo);
    expect(scan.state).toBe('dirty');
    expect(scan.findings.map((finding) => finding.reason)).toEqual(expect.arrayContaining([
      'staged_change',
      'unstaged_change',
      'untracked_path',
      'ignored_path',
    ]));

    const allowed = await scanWorkspaceStorageState(repo, { allowedIgnoredPaths: ['ignored.txt'] });
    expect(allowed.findings.some((finding) => finding.reason === 'ignored_path')).toBe(false);
  });

  it('refuses skip-worktree and assume-unchanged index flags', async () => {
    const repo = await makeRepo('storage-flags');
    writeFileSync(path.join(repo, 'skip.txt'), 'skip\n');
    git(repo, 'add', 'skip.txt');
    git(repo, 'commit', '-qm', 'add skip target');
    git(repo, 'update-index', '--assume-unchanged', 'tracked.txt');
    git(repo, 'update-index', '--skip-worktree', 'skip.txt');

    const scan = await scanWorkspaceStorageState(repo);
    expect(scan.state).toBe('dirty');
    expect(scan.findings.filter((finding) => finding.reason === 'hidden_index_flag').map((finding) => finding.path))
      .toEqual(expect.arrayContaining(['tracked.txt', 'skip.txt']));
  });

  it('holds tracked submodules and detects unrelated nested repositories', async () => {
    const child = await makeRepo('storage-submodule-child');
    const parent = await makeRepo('storage-submodule-parent');
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/child');
    git(parent, 'commit', '-qm', 'add submodule');

    const submoduleScan = await scanWorkspaceStorageState(parent);
    expect(submoduleScan.state).toBe('unknown');
    expect(submoduleScan.findings).toContainEqual(expect.objectContaining({
      reason: 'submodule_requires_recursive_verification',
      path: 'vendor/child',
    }));

    const nested = path.join(parent, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-q');
    const nestedScan = await scanWorkspaceStorageState(parent);
    expect(nestedScan.findings).toContainEqual(expect.objectContaining({ reason: 'nested_repository', path: 'nested' }));
  });

  it('inventories internal, absolute, and escaping symlinks without following them', async () => {
    const repo = await makeRepo('storage-links');
    mkdirSync(path.join(repo, 'links'));
    symlinkSync('../tracked.txt', path.join(repo, 'links', 'internal'));
    symlinkSync('/tmp', path.join(repo, 'links', 'absolute'));
    symlinkSync('../../outside', path.join(repo, 'links', 'escaping'));

    const scan = await scanWorkspaceStorageState(repo);
    expect(scan.symlinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'links/internal', disposition: 'internal' }),
      expect.objectContaining({ path: 'links/absolute', disposition: 'absolute' }),
      expect.objectContaining({ path: 'links/escaping', disposition: 'escaping' }),
    ]));
    expect(scan.findings.map((finding) => finding.reason)).toEqual(expect.arrayContaining([
      'absolute_symlink',
      'escaping_symlink',
    ]));
  });

  it('allows only an exact declared relative env binding outside the workspace', async () => {
    const sourceRepo = await makeRepo('storage-env-source');
    const workspace = await makeRepo('storage-env-workspace');
    const source = path.join(sourceRepo, '.env.local');
    writeFileSync(source, 'SECRET=redacted\n');
    writeFileSync(path.join(workspace, '.gitignore'), '.env.local\n');
    git(workspace, 'add', '.gitignore');
    git(workspace, 'commit', '-qm', 'ignore env binding');
    symlinkSync(path.relative(workspace, source), path.join(workspace, '.env.local'));

    const allowed = await scanWorkspaceStorageState(workspace, {
      allowedIgnoredPaths: ['.env.local'],
      allowedExternalSymlinks: {
        '.env.local': {
          target: path.relative(workspace, source),
          canonicalTarget: await realpath(source),
        },
      },
    });
    expect(allowed.state).toBe('verified_clean');
    expect(allowed.symlinks).toContainEqual(expect.objectContaining({
      path: '.env.local',
      disposition: 'declared_external',
    }));

    const wrongTarget = await scanWorkspaceStorageState(workspace, {
      allowedIgnoredPaths: ['.env.local'],
      allowedExternalSymlinks: {
        '.env.local': {
          target: '../wrong',
          canonicalTarget: await realpath(source),
        },
      },
    });
    expect(wrongTarget.state).toBe('dirty');
    expect(wrongTarget.findings).toContainEqual(expect.objectContaining({
      reason: 'escaping_symlink',
      path: '.env.local',
    }));
  });

  it('requires copied ignored environment bytes to match their captured source identity', async () => {
    const sourceRepo = await makeRepo('storage-copy-source');
    const workspace = await makeRepo('storage-copy-workspace');
    const source = path.join(sourceRepo, '.env.local');
    const destination = path.join(workspace, '.env.local');
    writeFileSync(source, 'TOKEN=registered-source\n');
    writeFileSync(destination, 'TOKEN=registered-source\n');
    writeFileSync(path.join(workspace, '.gitignore'), '.env.local\n');
    git(workspace, 'add', '.gitignore');
    git(workspace, 'commit', '-qm', 'ignore copied env');
    const identity = await captureWorkspaceRegularFileIdentity(source);
    const requiredCopyBindings = {
      '.env.local': {
        sourcePath: source,
        canonicalSourcePath: identity.canonicalPath,
        sourceIdentityFingerprint: identity.identityFingerprint,
        sourceContentFingerprint: identity.contentFingerprint,
      },
    };

    const clean = await scanWorkspaceStorageState(workspace, {
      allowedIgnoredPaths: ['.env.local'],
      requiredCopyBindings,
    });
    expect(clean.state).toBe('verified_clean');

    writeFileSync(destination, 'TOKEN=workspace-edit\n');
    const edited = await scanWorkspaceStorageState(workspace, {
      allowedIgnoredPaths: ['.env.local'],
      requiredCopyBindings,
    });
    expect(edited.state).toBe('dirty');
    expect(edited.findings).toContainEqual(expect.objectContaining({
      reason: 'copy_binding_mismatch',
      path: '.env.local',
    }));
  });

  it('fails closed when copied environment source truth disappears', async () => {
    const sourceRepo = await makeRepo('storage-copy-missing-source');
    const workspace = await makeRepo('storage-copy-missing-workspace');
    const source = path.join(sourceRepo, '.env.local');
    const destination = path.join(workspace, '.env.local');
    writeFileSync(source, 'TOKEN=registered-source\n');
    writeFileSync(destination, 'TOKEN=registered-source\n');
    writeFileSync(path.join(workspace, '.gitignore'), '.env.local\n');
    git(workspace, 'add', '.gitignore');
    git(workspace, 'commit', '-qm', 'ignore copied env');
    const identity = await captureWorkspaceRegularFileIdentity(source);
    rmSync(source);

    const scan = await scanWorkspaceStorageState(workspace, {
      allowedIgnoredPaths: ['.env.local'],
      requiredCopyBindings: {
        '.env.local': {
          sourcePath: source,
          canonicalSourcePath: identity.canonicalPath,
          sourceIdentityFingerprint: identity.identityFingerprint,
          sourceContentFingerprint: identity.contentFingerprint,
        },
      },
    });
    expect(scan.state).toBe('unknown');
    expect(scan.findings).toContainEqual(expect.objectContaining({
      reason: 'unreadable_path',
      path: '.env.local',
    }));
  });

  it('accepts configured safe absence only when source and destination are both absent', async () => {
    const sourceRepo = await makeRepo('storage-copy-absent-source');
    const workspace = await makeRepo('storage-copy-absent-workspace');
    const source = path.join(sourceRepo, '.env.local');
    writeFileSync(path.join(workspace, '.gitignore'), '.env.local\n');
    git(workspace, 'add', '.gitignore');
    git(workspace, 'commit', '-qm', 'ignore absent copied env');
    const requiredCopyBindings = {
      '.env.local': {
        sourcePath: source,
        canonicalSourcePath: null,
        sourceIdentityFingerprint: null,
        sourceContentFingerprint: null,
      },
    };

    const absent = await scanWorkspaceStorageState(workspace, {
      allowedIgnoredPaths: ['.env.local'],
      requiredCopyBindings,
    });
    expect(absent.state).toBe('verified_clean');

    writeFileSync(path.join(workspace, '.env.local'), 'TOKEN=orphaned-copy\n');
    const orphaned = await scanWorkspaceStorageState(workspace, {
      allowedIgnoredPaths: ['.env.local'],
      requiredCopyBindings,
    });
    expect(orphaned.state).toBe('dirty');
    expect(orphaned.findings).toContainEqual(expect.objectContaining({
      reason: 'copy_binding_mismatch',
      path: '.env.local',
    }));
  });

  it('scales declared rebuildable trees without spending the source-entry budget', async () => {
    const repo = await makeRepo('storage-large-rebuildable');
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-qm', 'ignore dependencies');
    mkdirSync(path.join(repo, 'node_modules'));
    writeFileSync(path.join(repo, 'node_modules', 'sentinel.js'), 'rebuildable\n');

    const fakeEntries = {
      *[Symbol.iterator]() {
        for (let index = 0; index < 100_001; index += 1) {
          yield {
            name: `package-${index}.js`,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          };
        }
      },
    };
    const fs: NonNullable<WorkspaceStorageVerifierOptions['fs']> = {
      lstat,
      readlink,
      realpath,
      readdir: (async (target: string, options: { withFileTypes: true }) => {
        if (target.endsWith(`${path.sep}node_modules`)) {
          return fakeEntries as unknown as Awaited<ReturnType<typeof readdir>>;
        }
        return readdir(target, options);
      }) as typeof readdir,
    };

    const scan = await scanWorkspaceStorageState(repo, {
      allowedIgnoredPaths: ['node_modules'],
      maxEntries: 10,
      fs,
    });
    expect(scan.state).toBe('verified_clean');
    expect(scan.scannedEntries).toBeLessThan(10);
    expect(scan.scannedRebuildableEntries).toBe(100_002);
  });

  it('still refuses unsafe links inside declared rebuildable roots', async () => {
    const repo = await makeRepo('storage-rebuildable-links');
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-qm', 'ignore dependencies');
    mkdirSync(path.join(repo, 'node_modules'));
    symlinkSync('/tmp', path.join(repo, 'node_modules', 'absolute-link'));
    symlinkSync('../../outside', path.join(repo, 'node_modules', 'escaping-link'));

    const scan = await scanWorkspaceStorageState(repo, { allowedIgnoredPaths: ['node_modules'] });
    expect(scan.state).toBe('dirty');
    expect(scan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'absolute_symlink', path: 'node_modules/absolute-link' }),
      expect.objectContaining({ reason: 'escaping_symlink', path: 'node_modules/escaping-link' }),
    ]));
  });

  it('returns unknown for unreadable paths, scan bounds, and Git failures', async () => {
    const repo = await makeRepo('storage-unknown');
    mkdirSync(path.join(repo, 'locked'));
    writeFileSync(path.join(repo, 'locked', 'file.txt'), 'content\n');
    const fs: NonNullable<WorkspaceStorageVerifierOptions['fs']> = {
      lstat,
      readlink,
      realpath,
      readdir: (async (target: string, options: { withFileTypes: true }) => {
        if (target.endsWith(`${path.sep}locked`)) throw new Error('synthetic permission denial');
        return readdir(target, options);
      }) as typeof readdir,
    };

    const unreadable = await scanWorkspaceStorageState(repo, { fs });
    expect(unreadable.state).toBe('unknown');
    expect(unreadable.findings).toContainEqual(expect.objectContaining({ reason: 'unreadable_path', path: 'locked' }));

    const bounded = await scanWorkspaceStorageState(repo, { maxEntries: 1 });
    expect(bounded.state).toBe('unknown');
    expect(bounded.findings).toContainEqual(expect.objectContaining({ reason: 'scan_bound_exceeded' }));

    const gitFailure = await scanWorkspaceStorageState(repo, {
      runGit: async () => { throw new Error('synthetic git failure'); },
    });
    expect(gitFailure.state).toBe('unknown');
    expect(gitFailure.findings).toContainEqual(expect.objectContaining({ reason: 'git_error' }));
  });

  it('requires two identical clean scans around the snapshot boundary', async () => {
    const repo = await makeRepo('storage-double-scan');
    const first = await scanWorkspaceStorageState(repo);
    const second = await scanWorkspaceStorageState(repo);
    const matching = compareWorkspaceStorageScans(first, second, () => new Date('2026-08-14T00:00:00.000Z'));
    expect(matching).toMatchObject({ state: 'verified_clean', identical: true });

    writeFileSync(path.join(repo, 'late.txt'), 'late change\n');
    const changed = await scanWorkspaceStorageState(repo);
    const mismatch = compareWorkspaceStorageScans(first, changed);
    expect(mismatch.state).toBe('unknown');
    expect(mismatch.findings).toContainEqual(expect.objectContaining({ reason: 'scan_changed' }));
  });
});
