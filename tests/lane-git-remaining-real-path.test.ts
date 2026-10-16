import * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Lane } from '@/lib/lane/types';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const root = mkdtempSync(path.join(tmpdir(), 'o8-lane-git-remaining-'));
process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
const plants = new Map<string, (worktree: string) => void>();
vi.mock('@/lib/worker/runs', () => ({ fetchWorkerRun: () => ({ id: 'fixture', remoteBranch: 'packet/remote' }) }));
vi.mock('@/lib/lane/remote-fetch', async (original) => {
  const actual = await original<typeof import('@/lib/lane/remote-fetch')>();
  return { ...actual, fetchWorkerBranch: async (...args: Parameters<typeof actual.fetchWorkerBranch>) => {
    const result = await actual.fetchWorkerBranch(...args);
    if (result.ok) plants.get(args[0])?.(result.tempWorktreePath);
    return result;
  } };
});
vi.mock('@/lib/dispatch/decomposition-pipeline', () => ({ enqueueDecompositionsAfterMerge: async () => ({ enqueued: 0 }) }));
const { appendEvent, createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { performRemoteCustomerMerge } = await import('@/lib/lane/commands-remote-merge');
const { reconcileOrphanedWorktrees } = await import('@/lib/lane/reconcile');
const { laneGit, laneGitSync } = await import('@/lib/lane/lane-git');
const { captureWorktreeState } = await import('@/lib/lane/worktree-capture');
const { checkUntrackedImports } = await import('@/lib/lane/check-untracked-imports');
const { checkPruneGate } = await import('@/lib/lane/prune-gate');
const { cleanupLaneWorktree, worktreeIsNotGitRepository } = await import('@/lib/lane/worktree-cleanup');
const { closeDb } = await import('@/lib/db');

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function fixture(name: string) {
  const directory = path.join(root, name);
  const repo = path.join(directory, 'repo');
  const bare = path.join(directory, 'origin.git');
  const markers = path.join(directory, 'markers');
  mkdirSync(repo, { recursive: true });
  mkdirSync(markers);
  git(repo, ['init', '-qb', 'main']);
  git(repo, ['config', 'user.name', 'Test Author']);
  git(repo, ['config', 'user.email', 'test@example.test']);
  writeFileSync(path.join(repo, 'source.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  git(repo, ['clone', '--bare', repo, bare]);
  git(repo, ['remote', 'add', 'origin', bare]);
  git(repo, ['checkout', '-qb', 'packet/remote']);
  writeFileSync(path.join(repo, 'source.txt'), 'remote\n');
  git(repo, ['commit', '-qam', 'fix: remote change']);
  git(repo, ['push', 'origin', 'packet/remote']);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['branch', '-D', 'packet/remote']);
  git(repo, ['config', 'extensions.worktreeConfig', 'true']);
  const lane = createLane({ repoPath: repo, branch: 'packet/remote', baseBranch: 'main', runtime: 'remote-customer' as Lane['runtime'] });
  const plant = (worktree: string) => {
    const script = (name: string, tail = '') => {
      const file = path.join(directory, name + '.sh');
      writeFileSync(file, '#!/bin/sh\n: > ' + JSON.stringify(path.join(markers, name)) + '\n' + tail, { mode: 0o755 });
      return file;
    };
    const config = (key: string, value: string) => git(worktree, ['config', '--worktree', key, value]);
    config('core.fsmonitor', script('monitor'));
    config('filter.marker.clean', script('clean', 'cat\n'));
    config('core.sshCommand', script('ssh'));
    config('credential.helper', script('credential'));
    config('core.askPass', script('askpass'));
    config('core.gitProxy', script('proxy'));
    config('remote.origin.uploadpack', script('uploadpack'));
    config('remote.origin.receivepack', script('receivepack'));
    writeFileSync(path.join(worktree, '.gitattributes'), 'source.txt filter=marker\n');
    return worktree;
  };
  return { repo, bare, markers, lane, plant, directory };
}
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

describe('remaining lane Git real entry points', () => {
  it('remote merge commits and lands work without executing lane programs', async () => {
    const f = fixture('remote-merge');
    plants.set(f.repo, f.plant);
    const result = await performRemoteCustomerMerge(f.lane, {
      verb: 'merge', laneId: f.lane.id, commitMessage: 'fix: land remote work',
    }, 'system');
    expect(result.ok).toBe(true);
    expect(getLane(f.lane.id)?.status).toBe('completed');
    expect(readdirSync(f.markers)).toEqual([]);
    expect(git(f.repo, ['show', 'main:source.txt'])).toBe('remote');
    expect(git(f.repo, ['ls-remote', f.bare, 'main']).split(/\s+/)[0]).toBe(git(f.repo, ['rev-parse', 'main']));
  });

  it('reconcile reads host ancestry, ignoring programs in a surviving lane', async () => {
    const f = fixture('reconcile');
    const worktree = path.join(f.directory, 'lane');
    git(f.repo, ['fetch', 'origin', 'packet/remote']);
    git(f.repo, ['worktree', 'add', '-qb', 'packet/reconcile', worktree, 'origin/packet/remote']);
    const lane = createLane({ repoPath: f.repo, worktreePath: worktree, branch: 'packet/reconcile',
      baseBranch: 'main', runtime: 'codex', baseCommit: git(f.repo, ['rev-parse', 'main']) });
    git(f.repo, ['merge', '--ff-only', 'packet/reconcile']);
    appendEvent(lane.id, 'merge', 'system', { laneHeadSha: git(worktree, ['rev-parse', 'HEAD']) });
    git(worktree, ['checkout', '--detach']);
    git(f.repo, ['branch', '-D', 'packet/reconcile']);
    f.plant(worktree);
    setLaneStatus(lane.id, 'reviewing', 'system', 'fixture');
    expect(await reconcileOrphanedWorktrees()).toBe(1);
    expect(getLane(lane.id)?.status).toBe('completed');
    expect(readdirSync(f.markers)).toEqual([]);
  });

  it('default untracked-import runner reports the real missing dependency without executing lane programs', () => {
    const f = fixture('untracked-imports');
    const worktree = path.join(f.directory, 'lane');
    git(f.repo, ['worktree', 'add', '-qb', 'packet/imports', worktree]);
    writeFileSync(path.join(worktree, 'feature.ts'), "import { value } from './dependency';\nexport { value };\n");
    git(worktree, ['add', 'feature.ts']);
    git(worktree, ['commit', '-qm', 'fix: add import']);
    writeFileSync(path.join(worktree, 'dependency.ts'), 'export const value = 1;\n');
    f.plant(worktree);
    const lane = createLane({ repoPath: f.repo, worktreePath: worktree, branch: 'packet/imports',
      baseBranch: 'main', runtime: 'codex' });
    const result = checkUntrackedImports(worktree, lane.baseBranch, lane.repoPath);
    expect(result.ok).toBe(false);
    expect(result.untrackedFiles).toEqual(['dependency.ts']);
    expect(result.importingFiles).toEqual(['feature.ts']);
    expect(readdirSync(f.markers)).toEqual([]);
  });

  it('refuses corrupt-metadata pruning and skips capture without blocking terminal sweep classification', async () => {
    const f = fixture('metadata-cleanup');
    const worktree = path.join(f.directory, 'lane');
    git(f.repo, ['worktree', 'add', '-qb', 'packet/cleanup', worktree]);
    f.plant(worktree);
    writeFileSync(path.join(worktree, '.git'), 'gitdir: ' + path.join(f.repo, '.git') + '\n');
    const lane = createLane({ repoPath: f.repo, worktreePath: worktree, branch: 'packet/cleanup',
      baseBranch: 'main', runtime: 'codex' });
    expect(await captureWorktreeState(worktree, lane.id, lane.repoPath)).toEqual({ captured: false });
    expect(await checkPruneGate({ repoRoot: lane.repoPath, worktreePath: worktree })).toMatchObject({
      ok: false, reason: 'git_metadata_untrusted',
    });
    expect(await checkPruneGate({ repoRoot: lane.repoPath, worktreePath: worktree, operatorForce: true }))
      .toMatchObject({ ok: true, forced: true, reason: 'git_metadata_untrusted' });
    expect(await cleanupLaneWorktree(lane, { terminal: true, force: true })).toBe(false);
    expect(await worktreeIsNotGitRepository(worktree, lane.repoPath)).toBe(true);
    expect(readdirSync(f.markers)).toEqual([]);
  });

  for (const command of ['ls-remote', 'fetch', 'push']) {
    it(command + ' neutralizes lane upload-pack and receive-pack programs for a local bare remote', async () => {
      const f = fixture('transport-' + command);
      const worktree = path.join(f.directory, 'lane');
      git(f.repo, ['worktree', 'add', '-qb', 'packet/transport', worktree]);
      f.plant(worktree);
      const args = command === 'push' ? ['push', 'origin', 'HEAD:refs/heads/transport']
        : command === 'fetch' ? ['fetch', 'origin', 'main'] : ['ls-remote', 'origin'];
      const result = await laneGit(worktree, f.repo, args);
      if (command === 'ls-remote') expect(result.stdout).toContain('refs/heads/main');
      expect(readdirSync(f.markers)).toEqual([]);
    });
  }

  for (const transport of ['ssh', 'git']) {
    it(transport + ' transport never executes the lane SSH or proxy program', async () => {
      const f = fixture('program-' + transport);
      const worktree = path.join(f.directory, 'lane');
      git(f.repo, ['worktree', 'add', '-qb', 'packet/program', worktree]);
      f.plant(worktree);
      // An unavailable loopback port needs no external service or credentials.
      await expect(laneGit(worktree, f.repo, ['ls-remote', transport + '://127.0.0.1:1' + f.bare])).rejects.toThrow();
      expect(readdirSync(f.markers)).toEqual([]);
    });
  }

  it('credential fill never executes the lane credential or askpass program', () => {
    const f = fixture('credential');
    const worktree = path.join(f.directory, 'lane');
    git(f.repo, ['worktree', 'add', '-qb', 'packet/credential', worktree]);
    f.plant(worktree);
    try {
      laneGitSync(worktree, f.repo, ['credential', 'fill'], {
        input: 'protocol=https\nhost=fixture.invalid\n\n', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* Missing credentials are expected; execution markers are the assertion. */ }
    expect(readdirSync(f.markers)).toEqual([]);
  });

  it('resets lane helpers and restores the global credential list in order', async () => {
    const f = fixture('global-credentials');
    const worktree = path.join(f.directory, 'lane');
    git(f.repo, ['worktree', 'add', '-qb', 'packet/global', worktree]);
    f.plant(worktree);
    const trusted = path.join(f.directory, 'trusted.sh');
    writeFileSync(trusted, '#!/bin/sh\n: > ' + JSON.stringify(path.join(f.markers, 'trusted'))
      + '\nprintf "username=fixture\\npassword=fixture-token\\n"\n', { mode: 0o755 });
    const original = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).execFileSync;
    // Keep real Git execution and lane config; substitute only the read-only
    // global-config enumeration so this test never edits operator credentials.
    const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((...args: Parameters<typeof original>) => {
      if (args[0] === 'git' && Array.isArray(args[1]) && args[1].includes('--global')) {
        return 'credential.helper\n\0credential.helper\n' + trusted + '\0';
      }
      return original(...args);
    }) as typeof original);
    try {
      const result = laneGitSync(worktree, f.repo, ['credential', 'fill'], {
        input: 'protocol=https\nhost=fixture.invalid\n\n', stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(result).toContain('username=fixture');
      expect(result).toContain('password=fixture-token');
      expect(readdirSync(f.markers)).toEqual(['trusted']);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a lane-selected remote helper before it can execute', async () => {
    const f = fixture('remote-helper');
    const worktree = path.join(f.directory, 'lane');
    git(f.repo, ['worktree', 'add', '-qb', 'packet/helper', worktree]);
    f.plant(worktree);
    mkdirSync(path.join(worktree, 'git-remote-.'));
    writeFileSync(path.join(worktree, 'git-remote-.', 'probe'),
      '#!/bin/sh\n: > ' + JSON.stringify(path.join(f.markers, 'helper')) + '\n', { mode: 0o755 });
    git(worktree, ['config', '--worktree', 'remote.origin.vcs', './probe']);
    await expect(laneGit(worktree, f.repo, ['ls-remote', 'origin'])).rejects.toThrow(/Git metadata/);
    expect(readdirSync(f.markers)).toEqual([]);
  });
});
